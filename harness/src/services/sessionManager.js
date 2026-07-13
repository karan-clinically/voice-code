// Session registry: ties live PTY sessions (terminal.js) to rows in the SQLite
// `sessions` table, tracks state (idle/busy/response_ready/dead), and emits
// change events the WS server (step 9) broadcasts.
//
// Spawn model: the harness owns every session, so a session dies when its PTY
// exits (onExit event) or when the harness restarts (all old rows -> dead on
// startup). tmux_pane stores a run-unique PTY key so DB ids are never recycled
// across restarts (which would mix interaction histories).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import * as terminal from './terminal.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('sessions');

// 'change' (any list change), 'state' {id, state}
export const sessionEvents = new EventEmitter();

// Unique per harness process, so a fresh 's1' after restart never collides with
// a previous run's row.
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

const dbIdByPty = new Map(); // terminalId -> dbId
const ptyIdByDb = new Map(); // dbId -> terminalId
const tokenByDb = new Map(); // dbId -> CVH_SESSION_ID token
const dbByToken = new Map(); // token -> dbId

const insertSession = db.prepare(`
  INSERT INTO sessions (tmux_session, tmux_pane, label, cwd, git_repo, git_branch, state, last_seen_at, kind, origin)
  VALUES (@tmux_session, @tmux_pane, @label, @cwd, @git_repo, @git_branch, @state, @last_seen_at, @kind, @origin)
`);
const updState = db.prepare('UPDATE sessions SET state = ?, last_seen_at = ? WHERE id = ?');
const touchSeen = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
const updLabel = db.prepare('UPDATE sessions SET label = ? WHERE id = ?');
const updClaudeId = db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?');
const selAll = db.prepare('SELECT * FROM sessions ORDER BY id DESC');
const selOne = db.prepare('SELECT * FROM sessions WHERE id = ?');

// Sessions from a previous harness run are dead — their PTYs died with the old
// process. Do this once at module load.
db.prepare("UPDATE sessions SET state = 'dead' WHERE state != 'dead'").run();

// Mark a session dead when its PTY exits.
terminal.terminalEvents.on('exit', ({ id }) => {
  const dbId = dbIdByPty.get(id);
  if (dbId == null) return;
  updState.run('dead', new Date().toISOString(), dbId);
  ptyIdByDb.delete(dbId);
  dbIdByPty.delete(id);
  sessionEvents.emit('state', { id: dbId, state: 'dead' });
  sessionEvents.emit('change');
  log.info(`session db#${dbId} (pty ${id}) marked dead`);
});

function decorate(row) {
  if (!row) return null;
  const ptyId = ptyIdByDb.get(row.id) || null;
  const alive = ptyId ? terminal.sessionExists(ptyId) : false;
  return { ...row, ptyId, alive };
}

// Spawn a new session and register it in the DB. kind 'claude' launches Claude
// Code directly; kind 'shell' launches PowerShell (for phone navigate-then-
// launch-claude). Pass `resumeId` (a Claude session UUID) to reopen a past
// conversation via `claude --resume <id>` — the cwd MUST be that transcript's
// original directory or Claude reports "No conversation found". The correlation
// token is injected as CVH_SESSION_ID so a Stop hook can map back to this session
// (primary matching is by cwd).
export async function createSession({ cwd, label = null, kind = 'claude', resumeId = null, origin = 'harness', agentView = false } = {}) {
  const token = randomUUID();
  const isShell = kind === 'shell';
  // agentView launches Claude's background-agent view (`claude agents`) so the phone
  // can attach to / peek a live background agent — those reject `--resume`. Once the
  // user hits Enter on a row, the same pty becomes that agent's live session.
  const claudeArgs = agentView ? ['agents'] : resumeId ? ['--resume', resumeId] : [];
  const view = terminal.spawnSession({
    cwd,
    label,
    env: { CVH_SESSION_ID: token },
    command: isShell ? 'powershell.exe' : undefined,
    args: isShell ? ['-NoLogo', '-NoExit'] : claudeArgs,
  });
  const git = await terminal.getGitInfo(view.cwd);
  const now = new Date().toISOString();
  const info = insertSession.run({
    tmux_session: view.name,
    tmux_pane: `${RUN_ID}:${view.id}`,
    label,
    cwd: view.cwd,
    git_repo: git.repo,
    git_branch: git.branch,
    state: 'idle',
    last_seen_at: now,
    kind,
    origin: origin === 'remote' ? 'remote' : 'harness',
  });
  const dbId = Number(info.lastInsertRowid);
  dbIdByPty.set(view.id, dbId);
  ptyIdByDb.set(dbId, view.id);
  tokenByDb.set(dbId, token);
  dbByToken.set(token, dbId);
  // A resumed session already knows its Claude UUID — link it to its archive row
  // up front (the Stop hook does the same for freshly-started sessions).
  if (resumeId) updClaudeId.run(resumeId, dbId);
  log.info(`registered session db#${dbId} (pty ${view.id}) cwd=${view.cwd} repo=${git.repo || '-'}`);
  sessionEvents.emit('change');
  return getSession(dbId);
}

export function listSessions() {
  return selAll.all().map(decorate);
}

export function getSession(id) {
  return decorate(selOne.get(Number(id)));
}

// Internal terminal id for a DB session id (used by the command pipeline).
export function getPtyId(id) {
  return ptyIdByDb.get(Number(id)) || null;
}

export function getToken(id) {
  return tokenByDb.get(Number(id)) || null;
}

export function getDbIdByToken(token) {
  return dbByToken.get(token) ?? null;
}

export function markState(id, state) {
  updState.run(state, new Date().toISOString(), Number(id));
  sessionEvents.emit('state', { id: Number(id), state });
  sessionEvents.emit('change');
}

export function renameSession(id, label) {
  updLabel.run(label, Number(id));
  sessionEvents.emit('change');
  return getSession(id);
}

// Record the Claude Code session UUID for a live session (from the Stop hook, or
// set up front for a resumed session). Idempotent: only writes on change.
export function setClaudeSessionId(id, claudeSessionId) {
  if (!claudeSessionId) return;
  const row = selOne.get(Number(id));
  if (!row || row.claude_session_id === claudeSessionId) return;
  updClaudeId.run(claudeSessionId, Number(id));
}

const updKind = db.prepare('UPDATE sessions SET kind = ? WHERE id = ?');
export function setKind(id, kind) {
  updKind.run(kind, Number(id));
  sessionEvents.emit('change');
  return getSession(id);
}

// Raw terminal I/O (used by the phone's shell-navigation mode).
export async function sendInput(id, text, opts) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.sendText(ptyId, text, opts);
}

// Send a raw key sequence (control chars) to a session's PTY — for the chat
// composer's mode-cycle (Shift+Tab) and stop (Esc). Callers pass only
// allowlisted sequences.
export function sendRawKey(id, seq) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.sendRaw(ptyId, seq);
}

// Resize a session's PTY so the TUI reflows to the caller's viewport — used by
// the phone terminal to render at the phone's width (fits without horizontal scroll).
export function resizeSession(id, cols, rows) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.resize(ptyId, cols, rows);
}

export async function readScreen(id, opts) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.captureScreenFlushed(ptyId, opts);
}

export async function readScreenColored(id, opts) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.captureColoredHtmlFlushed(ptyId, opts);
}

export function killSession(id) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) return false;
  return terminal.killSession(ptyId); // exit event flips state to 'dead'
}

// Periodic safety net: catch any PTY that died without firing onExit, and keep
// last_seen_at fresh for live sessions.
let timer = null;
export function startReconciler(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => {
    const now = new Date().toISOString();
    for (const [dbId, ptyId] of [...ptyIdByDb]) {
      if (!terminal.sessionExists(ptyId)) {
        updState.run('dead', now, dbId);
        ptyIdByDb.delete(dbId);
        dbIdByPty.delete(ptyId);
        sessionEvents.emit('state', { id: dbId, state: 'dead' });
        sessionEvents.emit('change');
        log.info(`reconciler marked session db#${dbId} dead`);
      } else {
        // Heal a session whose PTY is alive but whose DB state was left 'dead'
        // (e.g. a second harness's startup clobbered the shared DB). Typing
        // straight into the terminal never runs the state machine, so nothing
        // else would fix it.
        const row = selOne.get(dbId);
        if (row && row.state === 'dead') {
          updState.run('idle', now, dbId);
          sessionEvents.emit('state', { id: dbId, state: 'idle' });
          sessionEvents.emit('change');
          log.info(`reconciler healed session db#${dbId} (alive but marked dead)`);
        } else {
          touchSeen.run(now, dbId);
        }
      }
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopReconciler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
