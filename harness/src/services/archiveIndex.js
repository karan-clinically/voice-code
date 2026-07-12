// Session Archive indexer. Claude Code writes every session to
// ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl (the filename IS the
// session id). This service scans those transcripts into archive_sessions +
// an FTS5 index (archive_fts), incrementally by file mtime/size, so search and
// resume work over every past session without us logging anything ourselves.
//
// We index only real conversation text: user PROMPTS and assistant RESPONSE
// prose (top-level `text` blocks). Thinking, tool_use, tool_result and image
// blocks are skipped — they're the bulk of the 500MB corpus but noise for search.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import db from '../db.js';
import { PROJECTS_DIR, cleanPrompt, extractText } from './transcript.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('archive');

export { PROJECTS_DIR };

// Cap accumulated FTS text per column so a pathologically long session can't
// bloat the DB. Real prose rarely approaches this; search still finds long
// sessions via their earlier content + title.
const MAX_FTS_CHARS = 400_000;
const SNIPPET_CHARS = 220;

// --- prepared statements (lazy: DB is already migrated at import time) ---
const selMeta = db.prepare('SELECT file_mtime, file_size FROM archive_sessions WHERE uuid = ?');
const upsertSession = db.prepare(`
  INSERT INTO archive_sessions
    (uuid, file_path, project_dir, project_name, cwd, git_branch, title,
     first_prompt_snippet, first_ts, last_ts, msg_count, user_count, skills, mcp,
     file_mtime, file_size, indexed_at)
  VALUES
    (@uuid, @file_path, @project_dir, @project_name, @cwd, @git_branch, @title,
     @first_prompt_snippet, @first_ts, @last_ts, @msg_count, @user_count, @skills, @mcp,
     @file_mtime, @file_size, @indexed_at)
  ON CONFLICT(uuid) DO UPDATE SET
    file_path=excluded.file_path, project_dir=excluded.project_dir,
    project_name=excluded.project_name, cwd=excluded.cwd, git_branch=excluded.git_branch,
    title=excluded.title, first_prompt_snippet=excluded.first_prompt_snippet,
    first_ts=excluded.first_ts, last_ts=excluded.last_ts, msg_count=excluded.msg_count,
    user_count=excluded.user_count, skills=excluded.skills, mcp=excluded.mcp,
    file_mtime=excluded.file_mtime, file_size=excluded.file_size, indexed_at=excluded.indexed_at
`);
const delFts = db.prepare('DELETE FROM archive_fts WHERE uuid = ?');
const insFts = db.prepare('INSERT INTO archive_fts (prompts, responses, title, uuid) VALUES (?, ?, ?, ?)');
const delSession = db.prepare('DELETE FROM archive_sessions WHERE uuid = ?');
const allUuids = db.prepare('SELECT uuid FROM archive_sessions');

const writeOne = db.transaction((meta, prompts, responses) => {
  upsertSession.run(meta);
  delFts.run(meta.uuid);
  insFts.run(prompts, responses, meta.title || '', meta.uuid);
});

// Stream-parse one transcript into metadata + capped FTS text.
function parseTranscript(filePath, uuid, projectDir) {
  return new Promise((resolve, reject) => {
    const acc = {
      cwd: null, gitBranch: null, aiTitle: null, customTitle: null, firstPrompt: null,
      firstTs: null, lastTs: null, msgCount: 0, userCount: 0,
      skills: new Set(), mcp: new Set(),
    };
    let prompts = '';
    let responses = '';
    let promptsFull = false;
    let responsesFull = false;

    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.isSidechain) return; // sub-agent internals — not the user's conversation

      if (o.timestamp) {
        if (!acc.firstTs) acc.firstTs = o.timestamp;
        acc.lastTs = o.timestamp;
      }
      if (o.cwd) acc.cwd = o.cwd;           // constant per session; last wins is fine
      if (o.gitBranch) acc.gitBranch = o.gitBranch;
      // The friendly name a session actually shows: a user-set custom-title wins,
      // else Claude's generated ai-title. Both appear as their own line types;
      // last-wins keeps the freshest. (Older code only read ai-title, so
      // user-named sessions fell back to the uuid.)
      if (o.type === 'ai-title' && o.aiTitle) acc.aiTitle = o.aiTitle;
      if (o.type === 'custom-title' && o.customTitle) acc.customTitle = o.customTitle;

      if (o.type === 'user' && o.message && o.message.role === 'user' && !o.toolUseResult) {
        const t = cleanPrompt(extractText(o.message.content)); // drop caveat/command noise
        if (t) {
          acc.msgCount++;
          acc.userCount++;
          if (!acc.firstPrompt) acc.firstPrompt = t;
          if (!promptsFull) {
            prompts += t + '\n';
            if (prompts.length > MAX_FTS_CHARS) { prompts = prompts.slice(0, MAX_FTS_CHARS); promptsFull = true; }
          }
        }
      } else if (o.type === 'assistant' && o.message) {
        if (o.attributionSkill) acc.skills.add(o.attributionSkill);
        if (o.attributionMcpServer) acc.mcp.add(o.attributionMcpServer);
        const t = extractText(o.message.content).trim();
        if (t) {
          acc.msgCount++;
          if (!responsesFull) {
            responses += t + '\n';
            if (responses.length > MAX_FTS_CHARS) { responses = responses.slice(0, MAX_FTS_CHARS); responsesFull = true; }
          }
        }
      }
    });
    rl.on('close', () => {
      const snippet = (acc.firstPrompt || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
      // Title: Claude's aiTitle if present, else a short lead from the first
      // prompt (kept tab-label-sized), else the uuid stub.
      const titleFallback = snippet ? snippet.slice(0, 80).trim() : uuid.slice(0, 8);
      const meta = {
        uuid,
        file_path: filePath,
        project_dir: projectDir,
        project_name: acc.cwd ? basename(acc.cwd) : projectDir,
        cwd: acc.cwd,
        git_branch: acc.gitBranch,
        title: acc.customTitle || acc.aiTitle || titleFallback,
        first_prompt_snippet: snippet,
        first_ts: acc.firstTs,
        last_ts: acc.lastTs,
        msg_count: acc.msgCount,
        user_count: acc.userCount,
        skills: JSON.stringify([...acc.skills]),
        mcp: JSON.stringify([...acc.mcp]),
      };
      resolve({ meta, prompts, responses });
    });
    rl.on('error', reject);
  });
}

let indexing = false;

// Scan every transcript, (re)indexing only files whose mtime/size changed since
// last time. Prunes rows whose .jsonl no longer exists. Returns a summary.
export async function reindex() {
  if (indexing) return { skipped: true, reason: 'already running' };
  indexing = true;
  const started = Date.now();
  let scanned = 0, indexed = 0, unchanged = 0, failed = 0;
  const seen = new Set();
  try {
    if (!existsSync(PROJECTS_DIR)) {
      log.warn(`projects dir not found: ${PROJECTS_DIR}`);
      return { scanned: 0, indexed: 0 };
    }
    for (const projectDir of readdirSync(PROJECTS_DIR)) {
      const dirPath = join(PROJECTS_DIR, projectDir);
      let files;
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of files) {
        const uuid = file.slice(0, -6); // strip .jsonl
        const filePath = join(dirPath, file);
        let st;
        try { st = statSync(filePath); } catch { continue; }
        scanned++;
        seen.add(uuid);
        const mtime = Math.floor(st.mtimeMs);
        const prev = selMeta.get(uuid);
        if (prev && prev.file_mtime === mtime && prev.file_size === st.size) { unchanged++; continue; }
        try {
          const { meta, prompts, responses } = await parseTranscript(filePath, uuid, projectDir);
          meta.file_mtime = mtime;
          meta.file_size = st.size;
          meta.indexed_at = new Date().toISOString();
          if (!meta.last_ts && !meta.first_prompt_snippet) { unchanged++; continue; } // empty/degenerate file
          writeOne(meta, prompts, responses);
          indexed++;
        } catch (err) {
          failed++;
          log.warn(`index failed for ${uuid}: ${err.message}`);
        }
      }
    }
    // Prune transcripts that were deleted from disk.
    let removed = 0;
    for (const { uuid } of allUuids.all()) {
      if (!seen.has(uuid)) { delFts.run(uuid); delSession.run(uuid); removed++; }
    }
    const ms = Date.now() - started;
    log.info(`reindex: scanned=${scanned} indexed=${indexed} unchanged=${unchanged} removed=${removed} failed=${failed} in ${ms}ms`);
    return { scanned, indexed, unchanged, removed, failed, ms };
  } finally {
    indexing = false;
  }
}

// Kick off an initial index shortly after boot (non-blocking) + periodic rescan.
export function startIndexer({ initialDelayMs = 1500, intervalMs = 5 * 60_000 } = {}) {
  setTimeout(() => { reindex().catch((e) => log.error(`initial reindex: ${e.message}`)); }, initialDelayMs).unref?.();
  const timer = setInterval(() => { reindex().catch((e) => log.error(`reindex: ${e.message}`)); }, intervalMs);
  timer.unref?.();
  return timer;
}

// --- query helpers (used by routes/archive.js) ---

const liveClaudeIds = db.prepare(
  "SELECT claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL AND state != 'dead'"
);

// Every Claude session id this harness has ever owned (live or dead) — used to
// exclude harness-spawned sessions from the "external" list so they aren't shown
// in both the harness and remote-control groups.
const ownedClaudeIds = db.prepare(
  'SELECT claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL'
);

// Build a safe FTS5 MATCH expression from free-text: quote each term (so FTS
// special chars can't cause a syntax error), implicit-AND them.
function toMatch(q) {
  const terms = String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' ');
}

function liveSet() {
  return new Set(liveClaudeIds.all().map((r) => r.claude_session_id));
}

function shape(row, snippet, live) {
  return {
    uuid: row.uuid,
    title: row.title,
    project: row.project_name || row.project_dir,
    projectDir: row.project_dir,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    msgCount: row.msg_count,
    userCount: row.user_count,
    skills: safeParse(row.skills),
    mcp: safeParse(row.mcp),
    snippet: snippet || row.first_prompt_snippet || '',
    cwdExists: row.cwd ? existsSync(row.cwd) : false,
    live: !!live,
  };
}

function safeParse(s) {
  try { return JSON.parse(s) || []; } catch { return []; }
}

export function searchArchive({ q = '', project = '', limit = 60 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const live = liveSet();
  const match = q ? toMatch(q) : null;

  if (match) {
    const params = [match];
    let where = 'archive_fts MATCH ?';
    if (project) { where += ' AND s.project_dir = ?'; params.push(project); }
    params.push(lim);
    const rows = db.prepare(`
      SELECT s.*, snippet(archive_fts, -1, char(1), char(2), ' … ', 12) AS snip
      FROM archive_fts f JOIN archive_sessions s ON s.uuid = f.uuid
      WHERE ${where}
      ORDER BY bm25(archive_fts) LIMIT ?
    `).all(...params);
    return rows.map((r) => shape(r, r.snip, live.has(r.uuid)));
  }

  const params = [];
  let where = '';
  if (project) { where = 'WHERE project_dir = ?'; params.push(project); }
  params.push(lim);
  const rows = db.prepare(
    `SELECT * FROM archive_sessions ${where} ORDER BY last_ts DESC LIMIT ?`
  ).all(...params);
  return rows.map((r) => shape(r, null, live.has(r.uuid)));
}

// Claude Code sessions written to disk recently that this harness did NOT spawn —
// i.e. started in another terminal and driven from claude.ai remote control. The
// filename uuid IS the session id, so these resume through the same archive path.
// Excludes any uuid the harness owns (shown in the harness group instead).
// `active` = the transcript was touched within activeWindowMs (a good proxy for
// "being driven right now"); recency comes from file_mtime, refreshed by reindex.
export function recentExternalSessions({ sinceMs, activeWindowMs = 10 * 60_000, limit = 40 } = {}) {
  const owned = new Set(ownedClaudeIds.all().map((r) => r.claude_session_id));
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const now = Date.now();
  const rows = db
    .prepare('SELECT * FROM archive_sessions WHERE file_mtime >= ? ORDER BY file_mtime DESC LIMIT ?')
    .all(Math.floor(sinceMs), lim);
  return rows
    .filter((r) => !owned.has(r.uuid))
    .map((r) => ({
      ...shape(r, null, false),
      mtime: r.file_mtime,
      active: typeof r.file_mtime === 'number' && now - r.file_mtime < activeWindowMs,
    }));
}

const selOneArchive = db.prepare('SELECT * FROM archive_sessions WHERE uuid = ?');

export function getArchiveMeta(uuid) {
  const row = selOneArchive.get(uuid);
  if (!row) return null;
  return shape(row, null, liveSet().has(uuid));
}

// Distinct projects (for a filter dropdown), most-recent first.
export function listProjects() {
  return db.prepare(`
    SELECT project_dir AS dir, project_name AS name, COUNT(*) AS count, MAX(last_ts) AS lastTs
    FROM archive_sessions GROUP BY project_dir ORDER BY lastTs DESC
  `).all();
}

// First N real user prompts for a detail preview (re-reads the file, cheap).
export async function getArchivePrompts(uuid, n = 6) {
  const row = selOneArchive.get(uuid);
  if (!row || !existsSync(row.file_path)) return null;
  const prompts = [];
  const rl = createInterface({ input: createReadStream(row.file_path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (prompts.length >= n) { rl.close(); break; }
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === 'user' && o.message && o.message.role === 'user' && !o.toolUseResult) {
      const t = cleanPrompt(extractText(o.message.content));
      if (t) prompts.push(t.length > 600 ? t.slice(0, 600) + '…' : t);
    }
  }
  return { ...getArchiveMeta(uuid), prompts };
}
