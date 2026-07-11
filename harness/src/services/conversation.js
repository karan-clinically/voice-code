// Conversation store for the Chat view. Harness-spawned sessions don't persist a
// transcript to disk while live (verified), so the harness records the running
// conversation into the `messages` table:
//   - assistant turns  -> from the Stop hook (claudeCode.signalStop)
//   - user turns        -> from the chat box (/chat) and the voice pipeline (/command)
//   - resumed sessions  -> one-time backfill of prior history from the on-disk
//                          transcript (which the user's original CLI run wrote)

import db from '../db.js';
import { findTranscriptPath, parseMessages } from './transcript.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('conversation');

const insertMsg = db.prepare('INSERT INTO messages (session_id, role, text) VALUES (?, ?, ?)');
const lastAssistant = db.prepare(
  "SELECT text FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1"
);
const selAfter = db.prepare(
  'SELECT id, role, text, created_at FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC'
);
const countForSession = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');

export function recordUserMessage(sessionId, text) {
  const t = String(text || '').trim();
  if (!t) return;
  insertMsg.run(Number(sessionId), 'user', t);
}

// Single source of truth for assistant messages (Stop hook). Deduped against the
// session's last assistant row so a retried/duplicate hook can't double-post.
export function recordAssistantMessage(sessionId, text) {
  const t = String(text || '').trim();
  if (!t) return;
  const last = lastAssistant.get(Number(sessionId));
  if (last && last.text === t) return;
  insertMsg.run(Number(sessionId), 'assistant', t);
}

// Messages after a given id (0 = all), for incremental polling.
export function getMessages(sessionId, afterId = 0) {
  return selAfter.all(Number(sessionId), Number(afterId) || 0);
}

// Parse a resumed session's on-disk transcript once and seed the conversation with
// its prior history. No-ops if already backfilled or no transcript found.
export async function backfillFromTranscript(sessionId, uuid) {
  try {
    if (countForSession.get(Number(sessionId)).n > 0) return 0;
    const path = findTranscriptPath(uuid);
    if (!path) return 0;
    const msgs = await parseMessages(path);
    const insertMany = db.transaction((rows) => {
      for (const m of rows) insertMsg.run(Number(sessionId), m.role, m.text);
    });
    insertMany(msgs);
    log.info(`backfilled ${msgs.length} messages into session db#${sessionId} from ${uuid.slice(0, 8)}`);
    return msgs.length;
  } catch (err) {
    log.warn(`backfill failed for db#${sessionId}: ${err.message}`);
    return 0;
  }
}
