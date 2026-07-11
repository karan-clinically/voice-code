// SQLite (better-sqlite3) init + schema migrations.
// DB lives at ~/.claude-voice-harness/harness.db; audio cache alongside it.
// CVH_DATA_DIR overrides the directory (used by tests to avoid touching real data).

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = process.env.CVH_DATA_DIR || join(homedir(), '.claude-voice-harness');
export const AUDIO_DIR = join(DATA_DIR, 'audio');
export const DB_PATH = join(DATA_DIR, 'harness.db');

// recursive:true creates DATA_DIR too, and is a no-op if they already exist.
mkdirSync(AUDIO_DIR, { recursive: true });

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
}

export default db;
