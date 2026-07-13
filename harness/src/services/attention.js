// Per-session "wants your attention" state for the Sessions list badge, plus
// per-session push muting. Distinct from services/notify.js: a notification is a
// transient push (deduped, fire-and-forget), whereas attention is a STICKY badge
// that persists on the row until you actually open the session.
//
// Both are triggered by the same moments (notify.js computes needs-input /
// finished / failed from session state); notify.js calls setAttention() there so
// there is a single place that decides "this session pinged you".
//
// Attention is in-memory, keyed by harness session id — it is about live sessions
// you can open right now, so it need not survive a restart. Muting IS persisted
// (config table) so silencing a noisy session sticks across reconnects.

import { getConfig, setConfig, deleteConfig } from '../config.js';
import { getSession } from './sessionManager.js';

const attention = new Map(); // harnessId(number) -> { kind, at }

// kind: 'input' (needs your answer) | 'finished' (turn done) | 'failed' (errored).
export function setAttention(id, kind) {
  attention.set(Number(id), { kind, at: Date.now() });
}

export function clearAttention(id) {
  attention.delete(Number(id));
}

export function getAttention(id) {
  return attention.get(Number(id)) || null;
}

// Mute keys: prefer the stable Claude transcript uuid (survives a reconnect that
// spawns a fresh harness id over the same conversation), fall back to the harness
// id. isMuted checks both so a mute set before the session bridged still counts.
function muteKeys(session) {
  const keys = [`mute:h:${session.id}`];
  if (session.claude_session_id) keys.unshift(`mute:c:${session.claude_session_id}`);
  return keys;
}

export function isMuted(session) {
  if (!session) return false;
  return muteKeys(session).some((k) => getConfig(k) === '1');
}

export function setMuted(session, muted) {
  if (!session) return false;
  const keys = muteKeys(session);
  if (muted) setConfig(keys[0], '1'); // write the most stable key we have
  else keys.forEach(deleteConfig); // clear every variant so nothing lingers
  return muted;
}

// Convenience wrappers that resolve the session by harness id, for callers (the
// notifier, the route handlers) that only hold the id.
export function isMutedById(id) {
  return isMuted(getSession(id));
}

export function setMutedById(id, muted) {
  return setMuted(getSession(id), muted);
}
