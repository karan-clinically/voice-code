// Saved Grok conversations. The native Grok agent writes each conversation's full
// LLM context to <GROK_DIR>/<id>.json (see agents/grokAgent.js). This service reads
// those files back — to list resumable Grok sessions on the Sessions screen and to
// render a resumed Grok session's chat history — without the agent process running.
// The agent owns writing the files (atomic tmp+rename); this service only reads them,
// plus deletes one on explicit user request — a saved conversation is otherwise a row
// you can never clear, since Grok has no History screen to move it to.

import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GROK_DIR } from '../db.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('grok-archive');

// mtime/size cache so the 5s Sessions poll and the ~1.6s chat poll don't re-parse
// unchanged files. Keyed by conv id.
const cache = new Map(); // id -> { mtimeMs, size, data }

function readConv(id) {
  const file = join(GROK_DIR, `${id}.json`);
  let st;
  try { st = statSync(file); } catch { cache.delete(id); return null; }
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch (err) {
    log.warn(`parse failed for grok conv ${id}: ${err.message}`);
    return null;
  }
}

// One-line summary per saved conversation, newest first.
export function listGrokConversations() {
  let files;
  try {
    files = readdirSync(GROK_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -5); // strip .json
    const data = readConv(id);
    if (!data || !Array.isArray(data.messages)) continue;
    const userCount = data.messages.filter((m) => m.role === 'user').length;
    if (!userCount) continue; // nothing said yet — not worth a row
    out.push({
      id,
      cwd: data.cwd || null,
      title: data.title || id.slice(0, 8),
      model: data.model || null,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || data.createdAt || null,
      userCount,
    });
  }
  out.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  return out;
}

// One saved conversation's metadata by id (for the resume route), or null.
export function getGrokMeta(id) {
  const data = readConv(id);
  if (!data) return null;
  return {
    id,
    cwd: data.cwd || null,
    title: data.title || id.slice(0, 8),
    model: data.model || null,
    updatedAt: data.updatedAt || data.createdAt || null,
    userCount: Array.isArray(data.messages) ? data.messages.filter((m) => m.role === 'user').length : 0,
  };
}

// A conversation id is interpolated straight into a filename, so anything that isn't
// the uuid the agent mints (`randomUUID()`) is rejected rather than sanitised — an id
// containing `..` or a slash would otherwise reach outside GROK_DIR.
export const isGrokConvId = (id) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(id || ''));

// Forget a saved conversation: delete its context file. Returns false when there is
// nothing to delete. The caller must refuse this while the conversation is live —
// the agent would rewrite the file on its next turn.
export function deleteGrokConversation(id) {
  if (!isGrokConvId(id)) return false;
  try {
    unlinkSync(join(GROK_DIR, `${id}.json`));
    cache.delete(id);
    log.info(`deleted saved grok conversation ${id}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`delete failed for grok conv ${id}: ${err.message}`);
    cache.delete(id);
    return false;
  }
}

// Display messages for the chat view: user prompts + assistant prose only (tool
// calls, tool results and the system prompt are dropped, as in the archive index).
// Consecutive same-role blocks merge into one bubble.
export function getGrokConversationForView(id) {
  const data = readConv(id);
  if (!data || !Array.isArray(data.messages)) return null;
  const msgs = [];
  for (const m of data.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === m.role) prev.text += '\n\n' + text;
    else msgs.push({ role: m.role, text });
  }
  return msgs.map((m, i) => ({ id: i + 1, role: m.role, text: m.text }));
}
