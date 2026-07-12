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
import { makeLogger } from '../util/logger.js';

const log = makeLogger('claude');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;
const QUIET_MS = 1500; // PTY silent this long => probably done
const MIN_ELAPSED_MS = 1500; // ignore the first moment (command echo)
const WORKING_RE = /esc to interrupt|esc to cancel|thinking…|working…/i;

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

  let signal;
  try {
    signal = await waitForCompletion(session, ptyId, sentAt, timeoutMs);
  } catch (err) {
    sessions.markState(session.id, 'idle');
    throw err;
  }

  const response = await extractResponse(session, ptyId, signal, text);
  sessions.markState(session.id, 'response_ready');
  log.info(`session db#${session.id}: response ready via ${signal.via} (${response.length} chars)`);
  return { text: response, via: signal.via, stopReason: signal.stopReason || null };
}

function waitForCompletion(session, ptyId, sentAt, timeoutMs) {
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
      if (now - lastDataAt < QUIET_MS) return;
      let screen = '';
      try {
        screen = await terminal.captureScreenFlushed(ptyId, { full: false });
      } catch {
        /* transient */
      }
      if (WORKING_RE.test(screen)) return; // still working
      finish({ via: 'stabilization' });
    }, POLL_MS);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('timed out waiting for Claude to finish'));
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
// in-flight command by CVH_SESSION_ID token (if forwarded) or cwd, else — if
// exactly one command is in flight — that one.
export function signalStop({ sessionId, cwd, lastAssistantMessage, stopReason, transcriptPath }) {
  // Link the live session to its Claude transcript: session_id here is Claude's
  // real session UUID (the archive key). Persisting it lets the archive flag a
  // session that's currently live and cross-reference current <-> archived.
  if (sessionId) {
    const liveId = findSessionForBroadcast(sessionId, cwd);
    if (liveId != null) sessions.setClaudeSessionId(liveId, sessionId);
  }

  // Broadcast a 'turn' for every completed turn — including ones typed straight
  // into the terminal (no in-flight executeCommand). Lets the desktop speak the
  // reply on demand. Independent of the pending-command match below.
  if (typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()) {
    const turnDbId = findSessionForBroadcast(sessionId, cwd);
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

  if (pending.size === 0) return false;

  let dbId = null;

  if (sessionId) {
    const byToken = sessions.getDbIdByToken(sessionId);
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
  // Preferred: the exact text from the Stop hook payload.
  if (signal.via === 'hook' && signal.text && signal.text.trim()) {
    return signal.text.trim();
  }
  // Fallback: scrape the rendered screen.
  try {
    const screen = await terminal.captureScreenFlushed(ptyId, { full: true });
    return scrapeResponse(screen, sentText);
  } catch (err) {
    log.warn(`screen scrape failed for db#${session.id}: ${err.message}`);
    return '';
  }
}

// Heuristic extraction of Claude's response from the rendered TUI screen: take
// the lines after the echoed command, dropping Claude Code UI chrome (box
// borders, the input widget, status/footer lines).
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
  const footerRe = /^\s*(❯|✻|›|─{5,})|manual mode|auto-accept|\/effort|esc to (interrupt|cancel)|for shortcuts|⏸|▐▛/i;
  const cut = body.findIndex((l) => footerRe.test(l));
  if (cut !== -1) body = body.slice(0, cut);
  // Strip remaining chrome and leading response bullets / gutter bars.
  body = body
    .filter((l) => !isChrome(l))
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
