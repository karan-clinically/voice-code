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
import { guessInitialModel, friendlyModelName } from './models.js';
import { allAdapters, getAdapter, requireAdapter } from '../agents/registry.js';
import { spawnEnvironment } from '../agents/credentials.js';
import { screenState } from './activityState.js';
import { getSessionPreview, previewEvents, startSessionPreview, stopSessionPreview } from './previewManager.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('sessions');

// 'change' (any list change), 'state' {id, state}
export const sessionEvents = new EventEmitter();
previewEvents.on('change', () => sessionEvents.emit('change'));

// Unique per harness process, so a fresh 's1' after restart never collides with
// a previous run's row.
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

const dbIdByPty = new Map(); // terminalId -> dbId
const ptyIdByDb = new Map(); // dbId -> terminalId
const tokenByDb = new Map(); // dbId -> CVH_SESSION_ID token
const dbByToken = new Map(); // token -> dbId
const modelByDb = new Map(); // dbId -> friendly model label (Claude sessions only)
const agentViewByDb = new Set(); // exact marker; cwd is not unique to an agent view
const activityTimers = new Map(); // terminalId -> debounced live-screen check
const settleTimers = new Map(); // terminalId -> "terminal went quiet" check
// Claude repaints its spinner (and its elapsed counter) about once a second while
// a turn runs, so this much silence means nothing is running.
const SETTLE_MS = 3000;

const insertSession = db.prepare(`
  INSERT INTO sessions (
    tmux_session, tmux_pane, label, cwd, git_repo, git_branch, state,
    last_seen_at, kind, provider_id, adapter_version, capabilities_json, origin,
    handoff_parent_id, handoff_root_id
  ) VALUES (
    @tmux_session, @tmux_pane, @label, @cwd, @git_repo, @git_branch, @state,
    @last_seen_at, @kind, @provider_id, @adapter_version, @capabilities_json, @origin,
    @handoff_parent_id, @handoff_root_id
  )
`);
const updState = db.prepare('UPDATE sessions SET state = ?, last_seen_at = ? WHERE id = ?');
const touchSeen = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
const updLabel = db.prepare('UPDATE sessions SET label = ?, title_locked = ? WHERE id = ?');
const updTabColor = db.prepare('UPDATE sessions SET tab_color = ? WHERE id = ?');
const updExternalId = db.prepare('UPDATE sessions SET external_session_id = ?, claude_session_id = ? WHERE id = ?');
const selAll = db.prepare('SELECT * FROM sessions ORDER BY id DESC');
// Newest first: a folder's colour is whatever it was most recently given.
const selColored = db.prepare('SELECT cwd, tab_color FROM sessions WHERE tab_color IS NOT NULL ORDER BY id DESC');
const selOne = db.prepare('SELECT * FROM sessions WHERE id = ?');
const selLatestByClaude = db.prepare(
  'SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY id DESC LIMIT 1'
);
// Re-bind an existing (usually dead) row to a freshly spawned PTY instead of
// inserting a new row — see the resume re-adoption in createSession. `origin` is
// left untouched so a re-adopted row keeps reading as the Phone/PC session it began
// life as; label falls back to the stored one when the resume passes none.
const readoptSession = db.prepare(`
  UPDATE sessions SET
    tmux_session = @tmux_session, tmux_pane = @tmux_pane, label = COALESCE(@label, label),
    cwd = @cwd, git_repo = @git_repo, git_branch = @git_branch, state = 'idle',
    last_seen_at = @last_seen_at, kind = @kind, provider_id = @provider_id,
    adapter_version = @adapter_version, capabilities_json = @capabilities_json
  WHERE id = @id
`);

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
  modelByDb.delete(dbId);
  stopSessionPreview(dbId).catch((err) => log.warn(`preview cleanup for session db#${dbId} failed: ${err.message}`));
  sessionEvents.emit('state', { id: dbId, state: 'dead' });
  sessionEvents.emit('change');
  log.info(`session db#${dbId} (pty ${id}) marked dead`);
});

// Claude Code has no query API for the active model, so this scans raw PTY
// output for the confirmation line `/model` prints on a change ("Set model to
// X and saved..."). Catches a switch made through the harness's own model
// picker AND one typed straight into the terminal, so the two never drift.
// Strips ANSI/SGR codes first — the confirmation text is often wrapped in
// bold escapes (e.g. "Set model to \x1b[1mSonnet 5\x1b[22m and saved...").
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const MODEL_CONFIRM_RE = /Set model to\s+([^\r\n]+?)\s+and saved/i;
terminal.terminalEvents.on('data', ({ id, data }) => {
  const m = MODEL_CONFIRM_RE.exec(String(data).replace(ANSI_RE, ''));
  if (!m) return;
  const dbId = dbIdByPty.get(id);
  if (dbId == null) return;
  const label = friendlyModelName(m[1]) || m[1].trim();
  if (modelByDb.get(dbId) === label) return;
  modelByDb.set(dbId, label);
  sessionEvents.emit('change');
  log.info(`session db#${dbId}: model set to ${label}`);
});

// Input typed directly in xterm, another attached terminal, or Claude Remote
// Control bypasses executeCommand(), so it has no explicit "turn started" event
// and no awaitReply() to notice a picker. Reconcile from what is rendered instead:
// a spinner means working, a picker means waiting on a decision. Without this a
// prior Finished state lingers all turn, and a decision-pending session reads as
// "Working" until someone answers it.
// A 'busy' that nothing ever takes back: the Stop hook is what normally ends a
// turn, but an interrupted turn, a slash command, or a session whose hook never
// reaches us leaves the chip reading "Working" for good. Once the terminal has
// been silent and shows neither a spinner nor a picker, the turn is over — drop
// it to idle. Silently: 'finished' belongs to the Stop hook, and announcing this
// as a completion (or, via notify's busy→idle rule, as a failure) would be a lie.
function reconcileWhenQuiet(id, dbId) {
  clearTimeout(settleTimers.get(id));
  settleTimers.set(id, setTimeout(() => {
    settleTimers.delete(id);
    const row = selOne.get(dbId);
    const adapter = row ? getAdapter(row.provider_id || row.kind) : null;
    if (!row || row.state !== 'busy' || !adapter?.completion?.busyPatterns?.length) return;
    try {
      const screen = terminal.captureScreen(id, { full: false });
      if (screenState(screen, adapter.completion.busyPatterns) === null) {
        markState(dbId, 'idle', { silent: true });
      }
    } catch {
      /* terminal exited — the dead-session path owns it now */
    }
  }, SETTLE_MS));
}

terminal.terminalEvents.on('data', ({ id }) => {
  const dbId = dbIdByPty.get(id);
  if (dbId == null) return;
  reconcileWhenQuiet(id, dbId);
  if (activityTimers.has(id)) return;
  activityTimers.set(id, setTimeout(() => {
    activityTimers.delete(id);
    const row = selOne.get(dbId);
    const adapter = row ? getAdapter(row.provider_id || row.kind) : null;
    if (!row || row.state === 'dead' || !adapter?.completion?.busyPatterns?.length) return;
    try {
      const screen = terminal.captureScreen(id, { full: false });
      const next = screenState(screen, adapter.completion.busyPatterns);
      if (next && row.state !== next) markState(dbId, next);
    } catch {
      /* terminal may have exited between the output event and this check */
    }
  }, 120));
});

function decorate(row) {
  if (!row) return null;
  const providerId = row.provider_id || row.kind || 'claude';
  const adapter = getAdapter(providerId);
  const ptyId = ptyIdByDb.get(row.id) || null;
  const terminalSession = ptyId ? terminal.getSession(ptyId) : null;
  const alive = !!terminalSession?.alive;
  const model = providerId === 'claude' ? modelByDb.get(row.id) || null : null;
  let storedCapabilities = null;
  try { storedCapabilities = row.capabilities_json ? JSON.parse(row.capabilities_json) : null; } catch { /* ignore */ }
  return {
    ...row,
    kind: providerId,
    provider_id: providerId,
    external_session_id: row.external_session_id || row.claude_session_id || null,
    capabilities: adapter?.capabilities || storedCapabilities || { terminal: true },
    provider: adapter ? { id: adapter.id, name: adapter.name, icon: adapter.icon } : { id: providerId, name: providerId },
    ptyId,
    pid: terminalSession?.pid || null,
    agentView: agentViewByDb.has(row.id),
    alive,
    model,
    preview: getSessionPreview(row.id),
  };
}

// Spawn a new session and register it in the DB. kind 'claude' launches Claude
// Code directly; kind 'grok' launches Voice Harness's native Grok coding agent;
// kind 'codex' launches OpenAI Codex CLI via npx; kind 'shell' launches
// PowerShell (for phone navigate-then-launch-agent).
// Pass `resumeId` (a Claude session UUID) to reopen a past
// conversation via `claude --resume <id>` — the cwd MUST be that transcript's
// original directory or Claude reports "No conversation found". The correlation
// token is injected as CVH_SESSION_ID so a Stop hook can map back to this session
// (primary matching is by cwd).
export async function createSession({ cwd, label = null, kind = 'claude', providerId = null, resumeId = null, externalSessionId = null, grokConv = null, continueSession = false, origin = 'harness', agentView = false, credentialRef = null, model = null, handoffParentId = null, handoffRootId = null } = {}) {
  const adapter = requireAdapter(providerId || kind || 'claude');
  const token = randomUUID();
  // A Grok session's stable conversation id: reuse an existing one to resume with
  // memory, else mint a fresh one. Passed to the agent so it persists/loads its
  // context file, and stored on the row (see below) so the session list can
  // identify it and offer resume once the PTY is gone.
  const launch = await adapter.buildLaunchSpec({
    cwd,
    resumeId: externalSessionId || resumeId,
    externalSessionId: externalSessionId || resumeId,
    grokConv,
    continueSession,
    agentView,
    credentialRef,
    model,
  });
  const credentialEnv = spawnEnvironment(adapter, allAdapters());
  // agentView launches Claude's background-agent view (`claude agents`) so the phone
  // can attach to / peek a live background agent — those reject `--resume`. Once the
  // user hits Enter on a row, the same pty becomes that agent's live session.
  // continueSession runs `claude --continue` (resume the most-recent conversation in
  // cwd) so a terminal `claude -c` becomes harness-owned and shareable, not a fork.
  const view = terminal.spawnSession({
    cwd,
    label,
    env: {
      ...credentialEnv.env,
      CVH_SESSION_ID: token,
      CVH_PROVIDER_ID: adapter.id,
      ...(launch.env || {}),
    },
    removeEnv: credentialEnv.removeEnv,
    command: launch.command,
    args: launch.args || [],
  });
  const git = await terminal.getGitInfo(view.cwd);
  const now = new Date().toISOString();
  // Resuming a known conversation? If the harness already has a row for that Claude
  // UUID whose PTY has since died (a phone/PC session it owned before a disconnect
  // or a harness restart), re-bind THAT row to this new PTY instead of inserting
  // another. Otherwise every resume across a dead PTY piled up a fresh duplicate row
  // for the one conversation (six rows for one chat, in the wild).
  const resumeUuid = externalSessionId || resumeId || null;
  const priorRow = resumeUuid ? selLatestByClaude.get(resumeUuid) : null;
  const adopt = priorRow && !decorate(priorRow).alive ? priorRow : null;
  const fields = {
    tmux_session: view.name,
    tmux_pane: `${RUN_ID}:${view.id}`,
    label,
    cwd: view.cwd,
    git_repo: git.repo,
    git_branch: git.branch,
    state: 'idle',
    last_seen_at: now,
    kind: adapter.id,
    provider_id: adapter.id,
    adapter_version: adapter.version,
    capabilities_json: JSON.stringify(adapter.capabilities),
  };
  let dbId;
  if (adopt) {
    readoptSession.run({ ...fields, id: adopt.id });
    dbId = adopt.id;
    log.info(`re-adopted session db#${dbId} for resumed conversation ${resumeUuid}`);
  } else {
    const info = insertSession.run({
      ...fields,
      origin: origin === 'remote' ? 'remote' : 'harness',
      handoff_parent_id: handoffParentId == null ? null : Number(handoffParentId),
      handoff_root_id: handoffRootId == null ? null : Number(handoffRootId),
    });
    dbId = Number(info.lastInsertRowid);
  }
  // Sessions in one folder share a tab colour: colour a project once and every
  // session you start there arrives wearing it. Only ever fills an EMPTY colour,
  // so a re-adopted row keeps what it had and nothing overrides a deliberate pick.
  const currentColor = adopt ? getSession(dbId)?.tab_color : null;
  if (!currentColor) {
    const inherited = folderColorFrom(selColored.all(), view.cwd);
    if (inherited) updTabColor.run(inherited, dbId);
  }
  dbIdByPty.set(view.id, dbId);
  ptyIdByDb.set(dbId, view.id);
  if (agentView) agentViewByDb.add(dbId);
  else agentViewByDb.delete(dbId); // a dead agent-view row may be re-adopted normally
  tokenByDb.set(dbId, token);
  dbByToken.set(token, dbId);
  if (adapter.id === 'claude') modelByDb.set(dbId, model ? friendlyModelName(model) : guessInitialModel(view.cwd));
  // A resumed session already knows its Claude UUID — link it to its archive row
  // up front (the Stop hook does the same for freshly-started sessions).
  const providerSessionId = launch.externalSessionId || externalSessionId || resumeId || null;
  if (providerSessionId) updExternalId.run(providerSessionId, providerSessionId, dbId);
  log.info(`registered session db#${dbId} (pty ${view.id}) cwd=${view.cwd} repo=${git.repo || '-'}`);
  if (!agentView && adapter.id !== 'shell') {
    startSessionPreview(dbId, view.cwd).catch((err) => {
      log.warn(`preview auto-start for session db#${dbId} failed: ${err.message}`);
    });
  }
  sessionEvents.emit('change');
  return getSession(dbId);
}

// The colour a folder is already using, so a new session in it looks like its
// siblings instead of arriving uncoloured. Comparison is normalised because the
// same directory reaches us spelled several ways — a trailing slash from a picker,
// a different drive-letter case from a shell. Rows come newest first, so the most
// recent choice wins. Pure, and given its rows, so the interesting part is testable.
export function folderKey(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();
}
export function folderColorFrom(rows, cwd) {
  const key = folderKey(cwd);
  if (!key) return null;
  return rows.find((row) => row.tab_color && folderKey(row.cwd) === key)?.tab_color || null;
}

export function listSessions() {
  return selAll.all().map(decorate);
}

// The session list as a CLIENT should see it. listSessions() itself stays
// complete — the reuse map, the archive linker and the provider probe all scan it
// and a filtered view would quietly break them — but a UI only ever renders live
// sessions plus, briefly, one that just exited. Unfiltered this reached 290KB
// across 333 rows, and /ws re-broadcasts the whole array on every state change
// (several times per turn), so the cost grew with every session ever created.
const CLIENT_DEAD_LIMIT = 20;
export function clientSessionView(all, deadLimit = CLIENT_DEAD_LIMIT) {
  const recentDead = all
    .filter((s) => !s.alive)
    .sort((a, b) => Date.parse(b.last_seen_at || 0) - Date.parse(a.last_seen_at || 0))
    .slice(0, deadLimit);
  const keep = new Set(recentDead.map((s) => s.id));
  return all.filter((s) => s.alive || keep.has(s.id)); // original order preserved
}

export function listSessionsForClients() {
  return clientSessionView(listSessions());
}

export function getSession(id) {
  return decorate(selOne.get(Number(id)));
}

// Freshest session row (alive or dead) for a Claude conversation UUID. Lets the
// /recent classifier recognise a bridged conversation the harness ORIGINATED, so a
// phone/PC session whose PTY has since died is still badged by where it was started
// rather than surfacing as an anonymous "Remote control" row.
export function latestSessionByClaudeId(claudeSessionId) {
  if (!claudeSessionId) return null;
  return decorate(selLatestByClaude.get(claudeSessionId));
}

// Reuse map so tapping a Sessions-list row that would SPAWN a session (a resume,
// a background-agent view) returns the one you already opened instead of piling
// up duplicates. Keyed by open-identity (`resume:<uuid>`, `agent:<cwd>`); in-
// memory because the sessions it points at are live PTYs that die with the
// harness anyway. `reusableSession` returns the live session for a key (dropping
// the entry once it's dead), `recordReuse` registers a freshly opened one.
const reuseByKey = new Map();
export function reusableSession(key) {
  const id = reuseByKey.get(key);
  if (id == null) return null;
  const s = getSession(id);
  if (s && s.alive) return s;
  reuseByKey.delete(key);
  return null;
}
export function recordReuse(key, id) {
  reuseByKey.set(key, Number(id));
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

// Optimistic update after the harness itself sends `/model <alias>` — the PTY
// data listener above overwrites this with the confirmed label once Claude
// prints it (which may be more specific, e.g. "Sonnet 5" for the "sonnet" alias).
export function setModel(id, label) {
  modelByDb.set(Number(id), label);
  sessionEvents.emit('change');
}

// `silent` marks a state RECONCILED from what is on screen rather than observed
// from a real transition. It updates the row and the UI, but must not ping you:
// clearing a stuck "Working" is housekeeping, not news.
export function markState(id, state, { silent = false } = {}) {
  updState.run(state, new Date().toISOString(), Number(id));
  sessionEvents.emit('state', { id: Number(id), state, silent });
  sessionEvents.emit('change');
}

export function renameSession(id, label, { locked = true } = {}) {
  updLabel.run(label, locked ? 1 : 0, Number(id));
  sessionEvents.emit('change');
  return getSession(id);
}

export function setTabColor(id, color) {
  updTabColor.run(color, Number(id));
  sessionEvents.emit('change');
  return getSession(id);
}

// Record the Claude Code session UUID for a live session (from the Stop hook, or
// set up front for a resumed session). Idempotent: only writes on change.
export function setClaudeSessionId(id, claudeSessionId) {
  if (!claudeSessionId) return;
  const row = selOne.get(Number(id));
  if (!row || row.claude_session_id === claudeSessionId) return;
  updExternalId.run(claudeSessionId, claudeSessionId, Number(id));
}

export const setExternalSessionId = setClaudeSessionId;

const updKind = db.prepare(
  'UPDATE sessions SET kind = ?, provider_id = ?, adapter_version = ?, capabilities_json = ? WHERE id = ?'
);
export function setKind(id, kind) {
  const adapter = requireAdapter(kind);
  updKind.run(kind, kind, adapter.version, JSON.stringify(adapter.capabilities), Number(id));
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

export async function readScreenColoredPage(id, opts) {
  const ptyId = ptyIdByDb.get(Number(id));
  if (!ptyId) throw new Error('session has no live PTY');
  return terminal.captureColoredHtmlPageFlushed(ptyId, opts);
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
