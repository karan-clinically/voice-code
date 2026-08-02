// POST /api/command — run text in a session. JSON {text, sessionId} only.
// Flow: type into session -> wait for completion -> record interactions ->
// return response (summary + TTS).
//
// Deliberately text-only: audio never reaches a pty in one hop. Voice goes
// through /api/transcribe (batch) or /ws/stt (live), lands in the client's
// command box for review, and is sent here only when the user presses Send.

import { Router } from 'express';
import { getSession } from '../../services/sessionManager.js';
import { executeCommand } from '../../services/claudeCode.js';
import { recordUserMessage } from '../../services/conversation.js';
import { buildReplyResponse, recordUserInteraction } from '../../services/reply.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('command');
const router = Router();
// A phone can briefly retain/replay an outstanding POST across a network handoff
// or page lifecycle transition. executeCommand tracks one completion per session,
// so allowing the replay through would type the prompt twice and replace the first
// completion waiter. Coalesce an identical in-flight command; reject a genuinely
// different overlapping command until the current turn has settled.
const inFlight = new Map(); // session id -> { text, promise }

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

    const current = inFlight.get(session.id);
    if (current) {
      if (current.text !== sent) {
        return res.status(409).json({ error: 'This session is still processing the previous command' });
      }
      log.warn(`coalescing duplicate command for session ${session.id}`);
      return res.json({ transcript: sent, ...await current.promise });
    }

    const command = (async () => {
      recordUserInteraction(session.id, sent);
      recordUserMessage(session.id, sent); // Chat-view conversation log
      const result = await executeCommand(session, sent, timeoutMs ? { timeoutMs } : undefined);
      return buildReplyResponse(session, result, { desktopPlayback: req.body.desktopPlayback !== false });
    })();
    inFlight.set(session.id, { text: sent, promise: command });

    let payload;
    try {
      payload = await command;
    } finally {
      if (inFlight.get(session.id)?.promise === command) inFlight.delete(session.id);
    }
    res.json({ transcript: sent, ...payload });
  } catch (err) {
    log.error(`command error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
