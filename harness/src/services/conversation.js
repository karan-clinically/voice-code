// Conversation store for the Chat view. Two sources:
//   1. The LIVE on-disk transcript (.jsonl) — Claude Code writes it as it runs
//      (every text block, every turn), so `getLiveConversation` reads it directly
//      for the complete, current conversation, even one driven from another device.
//      Preferred whenever the session's Claude uuid resolves to a transcript file.
//   2. The harness `messages` table — fallback when no transcript is available
//      (uuid not yet known / not written). Recorded from:
//        - assistant turns -> the Stop hook (claudeCode.signalStop)
//        - user turns       -> the chat box (/chat) and the voice pipeline (/command)
//        - resumed sessions -> one-time backfill of prior history from the transcript

import { statSync } from 'node:fs';
import db from '../db.js';
import { findTranscriptPath, parseMessages } from './transcript.js';
import { getGrokConversationForView } from './grokArchive.js';
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

// Collapse consecutive same-role entries into one bubble (an assistant turn can
// emit several text blocks around tool calls — show them as one message).
function mergeConsecutive(rows) {
  const out = [];
  for (const m of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.text += '\n\n' + m.text;
    else out.push({ role: m.role, text: m.text });
  }
  return out;
}

// Re-parse the transcript only when its .jsonl actually changes (mtime + size),
// so a 1.6s chat poll doesn't re-read a multi-MB file every time.
const transcriptCache = new Map(); // uuid -> { mtimeMs, size, messages }

// The full LIVE conversation for a session. Claude Code writes the transcript
// .jsonl to disk as it runs (every text block, every turn), so reading it shows
// EVERYTHING — including a turn driven from another device — with no mirror pty.
// Falls back to the harness-recorded `messages` table when there is no transcript
// yet (uuid unknown / not written). `full:true` tells the client this is a whole-
// conversation snapshot to replace, not an incremental append.
export async function getLiveConversation(session, afterId = 0) {
  const uuid = session?.claude_session_id;
  // A Grok session's complete record is its own on-disk context file (keyed by the
  // conv id we stored in claude_session_id). Read it directly — the symmetric of
  // reading Claude's transcript below — so history survives across resumes and even
  // terminal-typed turns show up. Falls through to the messages table if unwritten.
  if (session?.kind === 'grok' && uuid) {
    const messages = getGrokConversationForView(uuid);
    if (messages && messages.length) return { messages, lastId: messages.length, full: true };
  }
  const path = uuid ? findTranscriptPath(uuid) : null;
  if (path) {
    try {
      const st = statSync(path);
      let cached = transcriptCache.get(uuid);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        const parsed = mergeConsecutive(await parseMessages(path));
        cached = { mtimeMs: st.mtimeMs, size: st.size, messages: parsed.map((m, i) => ({ id: i + 1, role: m.role, text: m.text })) };
        transcriptCache.set(uuid, cached);
      }
      return { messages: cached.messages, lastId: cached.messages.length, full: true };
    } catch (err) {
      log.warn(`live transcript read failed for ${uuid?.slice(0, 8)}: ${err.message}`);
    }
  }
  const rows = getMessages(session.id, afterId);
  const lastId = rows.length ? rows[rows.length - 1].id : afterId;
  return { messages: rows, lastId, full: false };
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
