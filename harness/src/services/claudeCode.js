// Completion detection + response extraction for a Claude Code session.
//
// executeCommand() types text into the session and waits for completion via a
// race of two signals:
//   A) Stop hook  — routes/hooks.js calls signalStop() when Claude's Stop hook
//      POSTs. The hook payload carries `last_assistant_message` (the exact text
//      Claude produced) which we use directly. This is the reliable path.
//   B) Stabilization — fallback when the hook isn't installed: watch the PTY
//      output stream go quiet while the rendered screen shows no "working"
//      indicator, then scrape the response off the screen.

import { EventEmitter } from 'node:events';
import * as terminal from './terminal.js';
import * as sessions from './sessionManager.js';
import { recordAssistantMessage } from './conversation.js';
import { summarizeForSpeech } from './summarize.js';
import { detectPrompt, promptToText } from './prompt.js';
import { makeLogger } from '../util/logger.js';
import { requireAdapter } from '../agents/registry.js';

const log = makeLogger('claude');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;
const QUIET_MS = 1500; // PTY silent this long => probably done
const MIN_ELAPSED_MS = 1500; // ignore the first moment (command echo)
// The working spinner ("esc to interrupt"). NOT "esc to cancel" — that's the
// footer of an interactive picker, where Claude is waiting, not working; treating
// it as "working" would hang detection until the timeout.
const DEFAULT_WORKING_RE = /esc to interrupt|thinking…|working…/i;

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => {
    try { return new RegExp(pattern, 'im').test(text); } catch { return false; }
  });
}

// dbId -> pending completion entry
const pending = new Map();

export async function executeCommand(session, text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ptyId = sessions.getPtyId(session.id);
  if (!ptyId) throw new Error(`session ${session.id} has no live PTY`);
  if (!terminal.sessionExists(ptyId)) throw new Error(`session ${session.id} is not alive`);

  sessions.markState(session.id, 'busy');
  const sentAt = Date.now();
  log.info(`session db#${session.id}: sending command (${text.length} chars)`);

  try {
    await terminal.sendText(ptyId, text);
  } catch (err) {
    sessions.markState(session.id, 'idle');
    throw err;
  }

  return awaitReply(session, ptyId, sentAt, timeoutMs, text);
}

// Wait for the in-flight turn to finish, then read the reply — or the interactive
// picker Claude is now waiting on — off the session. Shared by executeCommand
// (after typing text) and the picker-select route (after sending navigation keys),
// which both need "wait for Claude, then read what's on screen".
export async function awaitReply(session, ptyId, sentAt, timeoutMs = DEFAULT_TIMEOUT_MS, sentText = '') {
  let signal;
  try {
    signal = await waitForCompletion(session, ptyId, sentAt, timeoutMs);
  } catch (err) {
    sessions.markState(session.id, 'idle');
    throw err;
  }

  const response = await extractResponse(session, ptyId, signal, sentText);
  sessions.markState(session.id, response.prompt ? 'awaiting_input' : 'response_ready');
  const kind = response.prompt ? 'interactive prompt' : `${response.text.length} chars`;
  log.info(`session db#${session.id}: response ready via ${signal.via} (${kind})`);
  return { text: response.text, prompt: response.prompt || null, via: signal.via, stopReason: signal.stopReason || null };
}

function waitForCompletion(session, ptyId, sentAt, timeoutMs) {
  const adapter = requireAdapter(session.provider_id || session.kind);
  const completion = adapter.completion || {};
  return new Promise((resolve, reject) => {
    let done = false;
    let lastDataAt = Date.now();

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    // A) hook path — hooks route resolves this via signalStop()
    pending.set(session.id, {
      cwd: session.cwd,
      token: sessions.getToken(session.id),
      sentAt,
      resolve: (payload) => finish({ via: 'hook', ...payload }),
    });

    // B) stabilization path
    const onData = ({ id }) => {
      if (id === ptyId) lastDataAt = Date.now();
    };
    terminal.terminalEvents.on('data', onData);

    const poll = setInterval(async () => {
      if (done) return;
      const now = Date.now();
      if (now - sentAt < MIN_ELAPSED_MS) return;
      if (now - lastDataAt < Number(completion.quietMs || QUIET_MS)) return;
      let screen = '';
      try {
        screen = await terminal.captureScreenFlushed(ptyId, { full: false });
      } catch {
        /* transient */
      }
      const busy = completion.busyPatterns?.length
        ? matchesAny(screen, completion.busyPatterns)
        : DEFAULT_WORKING_RE.test(screen);
      if (busy) return;
      if (completion.idlePatterns?.length) {
        const lastLine = [...screen.split('\n')].reverse().find((l) => l.trim()) || '';
        if (!matchesAny(lastLine, completion.idlePatterns)) return;
      }
      finish({ via: 'stabilization' });
    }, POLL_MS);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`timed out waiting for ${adapter.name} to finish`));
    }, timeoutMs);

    function cleanup() {
      clearInterval(poll);
      clearTimeout(timer);
      terminal.terminalEvents.off('data', onData);
      pending.delete(session.id);
    }
  });
}

// Called by routes/hooks.js when a Stop hook POSTs. Matches the firing to an
// in-flight command by `token` (if forwarded) or cwd, else — if exactly one
// command is in flight — that one.
//
// `token` is our CVH_SESSION_ID correlation token; `sessionId` is Claude's
// transcript UUID. The native Grok agent posts only the token (as its id), so a
// `sessionId` that resolves to a known token is Grok's and is never stored as a
// Claude UUID.
export function signalStop({ sessionId, token = null, cwd, lastAssistantMessage, stopReason, transcriptPath }) {
  // `token` is our CVH_SESSION_ID, forwarded by the Stop hook as a header. It is an
  // EXACT per-PTY link and the only thing that can tell two Claude sessions sharing
  // one folder apart — cwd matching silently binds every hook to the newest row.
  // Falls back to cwd for a Claude the harness didn't spawn (no token).
  const rowId = () => findSessionForBroadcast(token, cwd);

  // Claude's transcript UUID rotates (a --resume or /compact starts a new one), so
  // re-read it every turn rather than trusting the value from spawn time. A stale
  // UUID splits one conversation into two rows and misreports whether it's bridged.
  // Skip our own token: the native Grok agent posts it here as its id.
  if (sessionId && sessions.getDbIdByToken(sessionId) == null) {
    const liveId = rowId();
    if (liveId != null) sessions.setClaudeSessionId(liveId, sessionId);
  }

  // Broadcast a 'turn' for every completed turn — including ones typed straight
  // into the terminal (no in-flight executeCommand). Lets the desktop speak the
  // reply on demand. Independent of the pending-command match below.
  if (typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()) {
    const turnDbId = rowId();
    if (turnDbId != null) {
      // Record the full assistant text for the Chat view (single source of truth
      // for assistant turns — fires for every input path incl. terminal-typed).
      recordAssistantMessage(turnDbId, lastAssistantMessage);
      // Summarizing is an async model call now, but signalStop stays synchronous
      // (routes/hooks.js uses its return value). The 'turn' event is consumed
      // asynchronously over the WebSocket anyway, so emit it when the summary lands.
      summarizeForSpeech(lastAssistantMessage)
        .then((spoken) => {
          if (spoken) events.emit('turn', { sessionId: turnDbId, text: spoken });
        })
        .catch((err) => log.warn(`spoken summary failed: ${err.message}`));
    }
  }

  // A turn typed straight into the terminal never goes through executeCommand, so
  // nothing ever marks the session busy/response_ready — notify.js sees no
  // transition and no "finished" push fires. The Stop hook IS the completion signal
  // for those turns, so drive the state machine here. We mark busy→response_ready
  // (not just response_ready) because notify dedupes on the last kind it sent and
  // only re-arms on 'busy' — without it, only the FIRST terminal turn would notify.
  // Sessions with a command in flight are skipped: awaitReply owns their state, and
  // it alone can tell a plain completion from one that stopped on a prompt.
  const doneId = rowId();
  if (doneId != null && !pending.has(doneId)) {
    sessions.markState(doneId, 'busy');
    sessions.markState(doneId, 'response_ready');
  }

  if (pending.size === 0) return false;

  let dbId = null;

  if (token) {
    const byToken = sessions.getDbIdByToken(token);
    if (byToken != null && pending.has(byToken)) dbId = byToken;
  }
  if (dbId == null && cwd) {
    let best = null;
    for (const [id, e] of pending) {
      if (e.cwd && sameDir(e.cwd, cwd) && (!best || e.sentAt > best.sentAt)) {
        best = e;
        dbId = id;
      }
    }
  }
  if (dbId == null && pending.size === 1) {
    dbId = [...pending.keys()][0];
  }
  if (dbId == null) {
    log.debug(`stop hook ignored (no pending match) cwd=${cwd || '-'}`);
    return false;
  }

  const entry = pending.get(dbId);
  entry.resolve({
    text: typeof lastAssistantMessage === 'string' ? lastAssistantMessage : null,
    stopReason: stopReason || null,
    transcriptPath: transcriptPath || null,
  });
  log.info(`stop hook resolved session db#${dbId}`);
  return true;
}

async function extractResponse(session, ptyId, signal, sentText) {
  const adapter = requireAdapter(session.provider_id || session.kind);
  let screen = '';
  try {
    screen = await terminal.captureScreenFlushed(ptyId, { full: true });
  } catch (err) {
    log.warn(`screen capture failed for db#${session.id}: ${err.message}`);
  }
  // Claude sitting on an interactive picker — surface the question + options, not
  // the raw hook text or scraped box-drawing chrome. The Stop hook doesn't fire
  // while Claude waits here, so this is how voice/chat learn about the question.
  const prompt = adapter.capabilities.prompts ? detectPrompt(screen) : null;
  if (prompt) return { text: promptToText(prompt), prompt };
  // Preferred: the exact text from the Stop hook payload.
  if (signal.via === 'hook' && signal.text && signal.text.trim()) {
    return { text: signal.text.trim() };
  }
  // Fallback: scrape the rendered screen. If answering a picker just returned to a
  // bare screen (e.g. /model closing), the scrape catches the boot banner — don't
  // record or speak that.
  const scraped = scrapeResponse(screen, sentText);
  return { text: looksLikeBanner(scraped) ? '' : scraped };
}

// The Claude Code welcome/boot banner (drawn at the top of a fresh screen), not a
// real reply. Distinct enough that a genuine answer won't trip it.
function looksLikeBanner(text) {
  return /Tips for getting started|Welcome back .+!|Claude Code v\d+\.\d+/i.test(text || '');
}

// Heuristic extraction of Claude's response from the rendered TUI screen: take
// the lines after the echoed command, dropping Claude Code UI chrome (box
// borders, the input widget, status/footer lines). Also used for the native
// Grok agent when the Stop-hook equivalent didn't carry text.
export function scrapeResponse(screen, sentText) {
  const lines = screen.split('\n');
  const needle = (sentText || '').trim().slice(0, 40);
  let start = 0;
  if (needle) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(needle)) {
        start = i + 1;
        break;
      }
    }
  }
  let body = lines.slice(start);
  // Cut everything from the first footer marker onward (input prompt, timing
  // line, status bar, separators) — that's Claude Code UI, not response text.
  // Grok's idle prompt is the equivalent footer.
  const footerRe = /^\s*(❯|✻|›|─{5,}|grok>)|manual mode|auto-accept|\/effort|esc to (interrupt|cancel)|for shortcuts|⏸|▐▛/i;
  const cut = body.findIndex((l) => footerRe.test(l));
  if (cut !== -1) body = body.slice(0, cut);
  // Strip remaining chrome, tool-trace lines, and leading response bullets / gutter bars.
  body = body
    .filter((l) => !isChrome(l))
    .filter((l) => !/^\s*→\s+\w+/.test(l)) // Grok tool traces: "→ read_file {...}"
    .filter((l) => !/^\s*thinking…\s*$/i.test(l))
    .map((l) => l.replace(/^\s*●\s?/, '').replace(/^\s*[│┃]\s?/, ''));
  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isChrome(line) {
  const t = line.trim();
  if (!t) return false; // keep blanks (collapsed later)
  if (/^[╭╮╰╯│─└┌┐┘├┤┬┴┼>·]+$/.test(t)) return true; // pure box borders / rules
  if (/^[╭╰][─╮╯│ ]*[╮╯│]$/.test(t)) return true; // bordered box row
  if (/esc to (interrupt|cancel)|for shortcuts|auto-accept|context left|▐▛|██|⏸ /i.test(t)) return true;
  return false;
}

// Rule-based summary for TTS (zero extra API cost). Claude Code responses are
// long and full of code; never speak them raw. Strip code blocks (replaced with
// a spoken note), markdown markers, collapse whitespace, and cap length — taking
// first + last paragraph when very long.
// Resolve a Stop-hook firing to a DB session id for the 'turn' broadcast,
// without needing an in-flight command. Prefer the CVH_SESSION_ID token, else
// the most-recent live session whose cwd matches.
function findSessionForBroadcast(sessionId, cwd) {
  if (sessionId) {
    const byToken = sessions.getDbIdByToken(sessionId);
    if (byToken != null) return byToken;
  }
  if (cwd) {
    let best = null;
    for (const s of sessions.listSessions()) {
      if (s.alive && s.cwd && sameDir(s.cwd, cwd)) {
        if (!best || s.id > best.id) best = s;
      }
    }
    if (best) return best.id;
  }
  return null;
}

// Compare two directory paths tolerant of slash direction and trailing slash.
function sameDir(a, b) {
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export const events = new EventEmitter();
