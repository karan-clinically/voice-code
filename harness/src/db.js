// SQLite (better-sqlite3) init + schema migrations.
// DB lives at ~/.claude-voice-harness/harness.db; audio cache alongside it.
// CVH_DATA_DIR overrides the directory (used by tests to avoid touching real data).

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = process.env.CVH_DATA_DIR || join(homedir(), '.claude-voice-harness');
export const AUDIO_DIR = join(DATA_DIR, 'audio');
export const UPLOADS_DIR = join(DATA_DIR, 'uploads');
// The native Grok agent persists each conversation's full LLM context here as
// <convId>.json, so a Grok session survives its PTY dying and can be resumed with
// memory intact (Claude gets this for free via its own on-disk transcript).
export const GROK_DIR = join(DATA_DIR, 'grok');
export const DB_PATH = join(DATA_DIR, 'harness.db');

// recursive:true creates DATA_DIR too, and is a no-op if they already exist.
mkdirSync(AUDIO_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });
mkdirSync(GROK_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // concurrent reads while the harness writes
db.pragma('foreign_keys = ON');

migrate(db);

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tmux_session  TEXT NOT NULL,   -- retained column name; holds the PTY session name
      tmux_pane     TEXT NOT NULL,   -- retained column name; holds the stable PTY id
      label         TEXT,
      cwd           TEXT,
      git_repo      TEXT,
      git_branch    TEXT,
      state         TEXT DEFAULT 'idle',  -- idle | busy | response_ready | dead
      last_seen_at  TEXT,
      UNIQUE(tmux_session, tmux_pane)
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER REFERENCES sessions(id),
      direction   TEXT NOT NULL,   -- 'user' | 'claude'
      text        TEXT NOT NULL,
      summary     TEXT,
      audio_path  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      level      TEXT,
      module     TEXT,
      message    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
  `);

  // Additive migration: session kind ('claude' | 'shell'). Ignored if present.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'claude'");
  } catch {
    /* column already exists */
  }

  // Additive migration: the Claude Code session UUID for a live session, captured
  // from the Stop hook's session_id. Links a live tab to its archive transcript.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
  } catch {
    /* column already exists */
  }

  // Additive migration: where the session was started from — 'harness' (the
  // desktop app on the PC, a localhost request) or 'remote' (the phone over
  // Tailscale, a bearer-token request). Lets the Sessions tab group by origin.
  // Rows predating this column default to 'harness'.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT DEFAULT 'harness'");
  } catch {
    /* column already exists */
  }

  // Provider-neutral adapter metadata. Keep the legacy columns during the
  // compatibility window; new code writes both old and new fields.
  for (const sql of [
    "ALTER TABLE sessions ADD COLUMN provider_id TEXT DEFAULT 'claude'",
    'ALTER TABLE sessions ADD COLUMN adapter_version INTEGER DEFAULT 1',
    'ALTER TABLE sessions ADD COLUMN external_session_id TEXT',
    'ALTER TABLE sessions ADD COLUMN credential_ref TEXT',
    'ALTER TABLE sessions ADD COLUMN capabilities_json TEXT',
  ]) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  db.exec(`
    UPDATE sessions SET provider_id = COALESCE(NULLIF(provider_id, ''), kind, 'claude');
    UPDATE sessions SET external_session_id = claude_session_id
      WHERE external_session_id IS NULL AND claude_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider_id, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(provider_id, external_session_id);
  `);

  // Additive migration: characters billed for this interaction's TTS, so voice
  // spend is visible per provider later. NULL for user rows / when TTS was off.
  try {
    db.exec('ALTER TABLE interactions ADD COLUMN tts_chars INTEGER');
  } catch {
    /* column already exists */
  }

  // Session Archive: metadata + FTS5 index over the ~/.claude/projects/*.jsonl
  // transcripts. Populated incrementally by services/archiveIndex.js (by mtime).
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_sessions (
      uuid                 TEXT PRIMARY KEY,   -- Claude session id (the .jsonl filename)
      file_path            TEXT NOT NULL,
      project_dir          TEXT,               -- slugified project folder name
      project_name         TEXT,               -- friendly name (basename of cwd)
      cwd                  TEXT,               -- original working dir (required to resume)
      git_branch           TEXT,
      title                TEXT,               -- Claude's aiTitle, else first-prompt snippet
      first_prompt_snippet TEXT,
      first_ts             TEXT,
      last_ts              TEXT,
      msg_count            INTEGER DEFAULT 0,
      user_count           INTEGER DEFAULT 0,
      skills               TEXT,               -- JSON array of distinct skills used
      mcp                  TEXT,               -- JSON array of distinct MCP tool/server tags
      file_mtime           INTEGER,            -- ms; incremental-reindex key
      file_size            INTEGER,
      indexed_at           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_archive_last_ts ON archive_sessions(last_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_project ON archive_sessions(project_dir);
  `);

  // Standalone FTS5 index (uuid unindexed so we can DELETE+reinsert per file on
  // re-index). Bundled better-sqlite3 ships FTS5.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
      prompts, responses, title, uuid UNINDEXED
    );
  `);

  // Conversation log for the Chat view. Harness-spawned sessions don't persist a
  // transcript to disk while live, so the harness records the conversation here:
  // assistant turns from the Stop hook, user turns from the chat box / /command,
  // and a one-time backfill of prior history when a session is resumed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      role        TEXT NOT NULL,   -- 'user' | 'assistant'
      text        TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  `);

  // Global reusable prompt snippets for the chat composer's "/" picker.
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_prompts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT NOT NULL,
      label       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // Per-call usage ledger for the spend tally. Records raw units (characters,
  // audio seconds, tokens) per provider call; the dollar cost is computed at read
  // time from adjustable rates, so re-pricing never rewrites history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT NOT NULL,   -- deepgram | elevenlabs | openai
      service     TEXT NOT NULL,   -- tts | stt | llm
      unit_type   TEXT NOT NULL,   -- deepgram_tts_char | deepgram_stt_sec | openai_in_token | ...
      units       REAL NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
  `);

  // Web Push subscriptions — one row per device that opted into notifications.
  // endpoint is the browser push service URL (unique per device); keys sign the
  // payload. Rows are pruned when the push service reports them gone (404/410).
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint    TEXT PRIMARY KEY,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

export default db;
