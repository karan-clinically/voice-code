// POST /api/command — run text in a session. JSON {text, sessionId} only.
// Flow: type into session -> wait for completion -> record interactions ->
// return response (summary + TTS).
//
// Deliberately text-only: audio never reaches a pty in one hop. Voice goes
// through /api/transcribe (batch) or /ws/stt (live), lands in the client's
// command box for review, and is sent here only when the user presses Send.
//
// While a turn is running, a NEW command queues instead of failing: it is sent
// automatically when the turn settles. Re-sending a queued command (the user
// pressing Send again) pushes it into the RUNNING conversation immediately —
// Claude Code's TUI accepts mid-turn input as steering, so the second Send is
// the "I mean now" gesture.

import { Router } from 'express';
import { getSession, getPtyId, sessionEvents } from '../../services/sessionManager.js';
import { executeCommand } from '../../services/claudeCode.js';
import { recordUserMessage, recordAssistantMessage } from '../../services/conversation.js';
import { buildReplyResponse, recordUserInteraction } from '../../services/reply.js';
import * as terminal from '../../services/terminal.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('command');
const router = Router();
// A phone can briefly retain/replay an outstanding POST across a network handoff
// or page lifecycle transition. executeCommand tracks one completion per session,
// so allowing the replay through would type the prompt twice and replace the first
// completion waiter. Coalesce an identical in-flight command; queue a genuinely
// different overlapping command until the current turn has settled.
const inFlight = new Map(); // session id -> { text, promise }
const queues = new Map(); // session id -> [text, ...] awaiting the turn's end
const MAX_QUEUED = 10;

// Session detail (routes/sessions.js) includes this so the phone can render a
// live "queued" chip that clears when the drain sends the command.
export function getQueuedCommands(sessionId) {
  return [...(queues.get(Number(sessionId)) || [])];
}

function runCommand(session, sent, timeoutMs, desktopPlayback) {
  const command = (async () => {
    recordUserInteraction(session.id, sent);
    recordUserMessage(session.id, sent); // Chat-view conversation log
    const result = await executeCommand(session, sent, timeoutMs ? { timeoutMs } : undefined);
    return buildReplyResponse(session, result, { desktopPlayback });
  })();
  inFlight.set(session.id, { text: sent, promise: command });
  const settle = () => {
    if (inFlight.get(session.id)?.promise === command) inFlight.delete(session.id);
    drain(session.id);
  };
  command.then(settle, settle);
  return command;
}

// Send the next queued command once nothing is in flight. Holds while the turn
// ended on an interactive prompt — typing a queued command into a permission
// dialog would answer the dialog with garbage; the prompt-answer path emits a
// state change that re-drains afterwards.
function drain(sessionId) {
  sessionId = Number(sessionId);
  const queue = queues.get(sessionId);
  if (!queue?.length || inFlight.has(sessionId)) return;
  const session = getSession(sessionId);
  if (!session?.alive) { queues.delete(sessionId); return; }
  if (session.state === 'awaiting_input' || session.state === 'busy') return;
  const sent = queue.shift();
  if (!queue.length) queues.delete(sessionId);
  log.info(`sending queued command for session ${sessionId} (${queue.length} still queued)`);
  runCommand(session, sent, undefined, true)
    .catch((err) => log.warn(`queued command failed for session ${sessionId}: ${err.message}`));
}

sessionEvents.on('state', ({ id, state }) => {
  if (state === 'dead') queues.delete(Number(id));
  else if (state === 'response_ready' || state === 'idle') drain(id);
});

// Shared busy-path handling for /api/command and the chat route. Returns null
// when nothing is in flight (caller runs the command normally); otherwise one of
// {coalesced, promise} — identical text already running, {injected} — the text
// was queued and this re-send pushed it into the running turn, or
// {queued, position} — parked until the turn settles. Throws with .status on
// a full queue or a missing PTY.
async function queueOrInject(session, sent) {
  const current = inFlight.get(session.id);
  if (!current) return null;
  if (current.text === sent) return { coalesced: true, promise: current.promise };
  const queue = queues.get(session.id) || [];
  const queuedAt = queue.indexOf(sent);
  if (queuedAt !== -1) {
    queue.splice(queuedAt, 1);
    if (queue.length) queues.set(session.id, queue); else queues.delete(session.id);
    const ptyId = getPtyId(session.id);
    if (!ptyId) throw Object.assign(new Error('session has no live PTY'), { status: 409 });
    recordUserInteraction(session.id, sent);
    recordUserMessage(session.id, sent);
    await terminal.sendText(ptyId, sent);
    log.info(`pushed queued command into running turn for session ${session.id}`);
    return { injected: true };
  }
  if (queue.length >= MAX_QUEUED) {
    throw Object.assign(new Error('too many queued commands for this session'), { status: 429 });
  }
  queue.push(sent);
  queues.set(session.id, queue);
  log.info(`queued command for session ${session.id} (${queue.length} waiting)`);
  return { queued: true, position: queue.length };
}

// Chat-view entry: identical queue/inject semantics, but fire-and-forget — the
// chat renders replies from the conversation-log poll, not from this response.
export async function submitChatCommand(session, sent) {
  const busy = await queueOrInject(session, sent);
  if (busy) return busy.coalesced ? { coalesced: true } : busy;
  runCommand(session, sent, undefined, true)
    // Deduped by conversation.js — covers stabilization-path completions the
    // Stop hook never records.
    .then((payload) => recordAssistantMessage(session.id, payload.responseText))
    .catch((err) => log.warn(`chat turn failed for db#${session.id}: ${err.message}`));
  return { started: true };
}

router.post('/', async (req, res) => {
  try {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (!session.alive) return res.status(409).json({ error: 'session is not alive' });

    // The user reviewed this text in the command box and pressed Send.
    const sent = (req.body.text || '').trim();
    if (!sent) return res.status(400).json({ error: 'text is required' });

    // Hands-free voice passes a short timeout so a turn that never signals
    // completion fails fast and the loop recovers, instead of the caller waiting
    // out the 10-minute default in dead silence. Clamped to a sane range.
    const raw = Number(req.body.timeoutMs);
    const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(raw, 10_000), 10 * 60_000) : undefined;

    const busy = await queueOrInject(session, sent);
    if (busy) {
      if (busy.coalesced) {
        log.warn(`coalescing duplicate command for session ${session.id}`);
        return res.json({ transcript: sent, ...await busy.promise });
      }
      return res.status(202).json({ transcript: sent, ...busy });
    }

    const payload = await runCommand(session, sent, timeoutMs, req.body.desktopPlayback !== false);
    res.json({ transcript: sent, ...payload });
  } catch (err) {
    log.error(`command error: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message });
  }
});

export default router;
