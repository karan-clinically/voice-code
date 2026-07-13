// Turns session activity into phone push notifications: needs input / finished /
// failed. Two sources feed it, both funnelled through one deduper so a device is
// never spammed:
//   1. sessionEvents 'state' — the command/chat/voice pipeline emits clean
//      transitions: busy→awaiting_input (needs input), busy→response_ready
//      (finished), busy→idle (an errored turn = failed).
//   2. a screen watcher — a background agent can hit a permission prompt on its own
//      without going through that pipeline, so poll live screens for a new prompt.
//
// Suppression while you're actively looking at a session is done client-side in the
// service worker (it skips the toast if a window is focused), which is the only side
// that knows what's on screen.

import { sessionEvents, listSessions, getSession, readScreen } from './sessionManager.js';
import { detectPrompt } from './prompt.js';
import { sendToAll, pushConfigured } from './push.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('notify');

const lastKind = new Map(); // sessionId -> last kind notified ('input'|'finished'|'failed')
const prevState = new Map(); // sessionId -> last state seen (for busy→idle = failed)

function labelFor(id) {
  const s = getSession(id);
  const base = s?.cwd ? String(s.cwd).split(/[\\/]/).filter(Boolean).pop() : null;
  return s?.label || base || `Session ${id}`;
}

const COPY = {
  input: (name) => ({ title: `🔔 ${name} needs your input`, body: 'Tap to answer.' }),
  finished: (name) => ({ title: `✓ ${name} finished`, body: 'Claude completed this turn.' }),
  failed: (name) => ({ title: `⚠ ${name} — something went wrong`, body: 'The last turn errored.' }),
};

function fire(id, kind, bodyOverride) {
  if (!pushConfigured()) return;
  if (lastKind.get(id) === kind) return; // don't repeat the same state
  lastKind.set(id, kind);
  const name = labelFor(id);
  const { title, body } = COPY[kind](name);
  sendToAll({ title, body: bodyOverride || body, sessionId: id, kind, tag: `sess-${id}` }).catch(
    (e) => log.warn(`sendToAll failed: ${e.message}`)
  );
}

// 1) State-driven (command / chat / voice turns).
sessionEvents.on('state', ({ id, state }) => {
  const prev = prevState.get(id);
  prevState.set(id, state);
  if (state === 'busy') {
    lastKind.delete(id); // a new turn started — arm the next notification
    return;
  }
  if (state === 'awaiting_input') fire(id, 'input');
  else if (state === 'response_ready') fire(id, 'finished');
  else if (state === 'idle' && prev === 'busy') fire(id, 'failed');
});

// 2) Screen watcher — catches prompts a background agent raises on its own.
async function watchTick() {
  if (!pushConfigured()) return;
  for (const s of listSessions()) {
    if (!s.alive) {
      lastKind.delete(s.id);
      prevState.delete(s.id);
      continue;
    }
    try {
      const p = detectPrompt(await readScreen(s.id, { full: false }));
      if (p && !p.multi) fire(s.id, 'input', p.question || 'Tap to answer.');
      else if (!p && lastKind.get(s.id) === 'input') lastKind.delete(s.id); // prompt cleared — re-arm
    } catch {
      /* transient */
    }
  }
}

let timer = null;
export function startNotifier(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(watchTick, intervalMs);
  log.info(`notifier started (push ${pushConfigured() ? 'enabled' : 'disabled — no VAPID keys'})`);
}
