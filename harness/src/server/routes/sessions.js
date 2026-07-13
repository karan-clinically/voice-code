// GET  /api/sessions        — list all known sessions (live + dead)
// GET  /api/sessions/:id     — one session
// POST /api/sessions         — spawn a new Claude Code session {cwd, label}
// POST /api/sessions/:id/kill — terminate a session
// POST /api/sessions/:id/rename — set label {label}
//
// The spawn model (node-pty) means sessions are created here, unlike the plan's
// tmux model where sessions were discovered from an external multiplexer.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import db, { UPLOADS_DIR } from '../../db.js';
import { getConfig } from '../../config.js';
import {
  listSessions, getSession, createSession, killSession, renameSession,
  sendInput, sendRawKey, resizeSession, readScreen, readScreenColored, setKind,
  getPtyId, markState,
} from '../../services/sessionManager.js';
import { isLocalhost } from '../auth.js';
import { getArchiveMeta, findArchiveByTitle } from '../../services/archiveIndex.js';
import { bridgeSuffixMap } from '../../services/claudeSessions.js';
import { codeSessions } from '../../services/codeSessions.js';
import { backgroundAgents } from '../../services/agentRegistry.js';
import { getRemoteSlug } from '../../services/terminal.js';
import { getAttention, clearAttention, isMutedById, setMutedById } from '../../services/attention.js';
import { getMessages, recordUserMessage, recordAssistantMessage } from '../../services/conversation.js';
import { executeCommand, awaitReply } from '../../services/claudeCode.js';
import { detectPrompt } from '../../services/prompt.js';
import { buildReplyResponse, recordUserInteraction } from '../../services/reply.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('sessions-route');
const router = Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Allowlisted raw key sequences clients may send (no arbitrary control chars).
// Shift+Tab cycles the permission mode; Esc interrupts / cancels; the rest let the
// phone answer interactive prompts (Enter, arrows) without a real keyboard.
const KEY_SEQS = {
  'cycle-mode': '\x1b[Z',
  stop: '\x1b',
  esc: '\x1b',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

// Footer strings Claude Code shows for each permission mode -> our label. Require
// the trailing "on" so boot-screen chatter (e.g. the "Auto mode is now available"
// What's-New note) can't be mistaken for the active mode.
function detectMode(screen) {
  const s = String(screen || '');
  if (/accept edits on/i.test(s)) return 'auto';
  if (/auto mode on/i.test(s)) return 'bypass';
  if (/plan mode on/i.test(s)) return 'plan';
  return 'ask'; // "manual mode on" / default
}

// Attachments are stored under a safe generated name; only a known set of
// extensions is allowed. Filenames from the client are never trusted.
const ATTACH_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.csv', '.json']);
let attachCounter = 0;

const selHistory = db.prepare(
  'SELECT id, direction, text, summary, audio_path, created_at FROM interactions WHERE session_id = ? ORDER BY id ASC'
);

router.get('/', (req, res) => {
  res.json({ sessions: listSessions() });
});

// Repo "owner/repo" slug per cwd, resolved off the git origin remote — cached and
// filled in the background so the (5s-polled) /recent handler never blocks on git.
// A cache miss returns null now and the slug appears on a later poll.
const slugCache = new Map(); // cwd -> "owner/repo" | null
const slugPending = new Set();
function repoSlug(cwd) {
  if (!cwd) return null;
  if (slugCache.has(cwd)) return slugCache.get(cwd);
  if (!slugPending.has(cwd)) {
    slugPending.add(cwd);
    getRemoteSlug(cwd)
      .then((slug) => slugCache.set(cwd, slug))
      .catch(() => slugCache.set(cwd, null))
      .finally(() => slugPending.delete(cwd));
  }
  return null;
}

const baseName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// The remote-control bridge can reconnect a session without a clean handoff,
// leaving the OLD connection's record stuck reporting connection_status
// "connected" server-side (the API exposes no lineage field to link a
// reconnect back to its predecessor) — surfacing as several near-identical rows
// for the same piece of work. Collapse those: group by name+repo; if any record
// in a group resolves to a live local process (bridgeSuffixMap), trust that one
// and drop the rest; otherwise keep only the most recently active record.
function collapseGhosts(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.name + '|' + (r.repo || '');
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const resolved = group.filter((r) => r.sessionId);
    if (resolved.length) {
      // Several ghosts can resolve to the SAME local transcript (title fallback) —
      // keep one row per transcript, the freshest.
      const byUuid = new Map();
      for (const r of resolved) {
        const prev = byUuid.get(r.sessionId);
        if (!prev || Date.parse(r.ts || 0) > Date.parse(prev.ts || 0)) byUuid.set(r.sessionId, r);
      }
      out.push(...byUuid.values());
    } else {
      out.push(group.reduce((a, b) => (Date.parse(b.ts || 0) > Date.parse(a.ts || 0) ? b : a)));
    }
  }
  return out;
}

// Connected + active sessions for the phone's Sessions tab, styled like the
// Claude Code app: one list (the client buckets it by day) of every session whose
// process is live right now — no time-window filter. Two sources:
//   • harness-spawned PTYs that are alive → origin 'Phone' / 'This PC'.
//   • live Claude sessions from ~/.claude/sessions/*.json (other terminals driven
//     from claude.ai remote control) → origin 'Remote control'.
// Each row carries a friendly name, whether it's Working (busy) or just Connected,
// and repo/branch + session id. Registered before '/:id'.
router.get('/recent', (req, res) => {
  const bridges = bridgeSuffixMap(); // app session id -> local transcript, for resume
  const bgList = [...backgroundAgents().values()]; // live background agents (reject --resume)

  // Disconnected sessions don't belong in this list — a session you can't reach
  // right now isn't "recent", it's history (resumable there instead).
  const remote = collapseGhosts(codeSessions().filter((s) => s.connected).map((s) => {
    const local = bridges.get(s.suffix) || null;
    let uuid = local?.sessionId || null;
    let meta = uuid ? getArchiveMeta(uuid) : null;
    // The pid registry only maps each terminal's CURRENT session; recover older
    // ones by title against the local transcript archive so they stay openable.
    // Cloud sessions are excluded — they have no local transcript at all.
    if (!uuid && s.envKind !== 'anthropic_cloud' && s.title) {
      meta = findArchiveByTitle(s.title);
      uuid = meta?.uuid || null;
    }
    const cwd = local?.cwd || meta?.cwd || null;
    // A background agent rejects --resume, so it must be reached through the agent
    // view instead. Match by transcript uuid, falling back to title (the agent's
    // live name), and let bgAgent drive the tap rather than a doomed resume.
    const bg = bgList.find((a) => (uuid && a.sessionId === uuid) || (s.title && a.name === s.title)) || null;
    return {
      key: 'c' + s.id,
      kind: 'code',
      name: bg?.name || s.title || (uuid ? uuid.slice(0, 8) : s.suffix.slice(0, 8)),
      connected: s.connected,
      active: bg ? bg.state === 'working' : s.working,
      unread: s.unread,
      origin: s.envKind === 'anthropic_cloud' ? 'cloud' : 'terminal',
      originLabel: bg ? 'Background agent' : s.envKind === 'anthropic_cloud' ? 'Cloud' : 'Remote control',
      repo: s.repo || repoSlug(bg?.cwd || cwd) || null,
      branch: s.branch || meta?.gitBranch || null,
      cwd: bg?.cwd || cwd,
      sessionId: uuid, // local transcript uuid, when this session ran on this PC
      ts: s.ts,
      bgAgent: !!bg, // route the tap to the agent view (attach/peek) not --resume
      agentCwd: bg?.cwd || null,
      resumeUuid: bg ? null : meta?.cwdExists ? uuid : null,
    };
  }));

  // A harness PTY that has bridged also appears in the API list — don't list twice.
  const seen = new Set(remote.map((r) => r.sessionId).filter(Boolean));
  const harness = listSessions()
    .filter((s) => s.alive && !(s.claude_session_id && seen.has(s.claude_session_id)))
    .map((s) => ({
      key: 'h' + s.id,
      kind: 'harness',
      name: s.label || baseName(s.cwd) || `Session ${s.id}`,
      connected: true,
      active: s.state === 'busy',
      unread: false,
      origin: s.origin === 'remote' ? 'phone' : 'pc',
      originLabel: s.origin === 'remote' ? 'Phone' : 'This PC',
      shell: s.kind === 'shell',
      repo: repoSlug(s.cwd) || s.git_repo || null,
      branch: s.git_branch || null,
      cwd: s.cwd || null,
      sessionId: s.claude_session_id || null,
      ts: s.last_seen_at,
      harnessId: s.id,
      alive: true,
      // Sticky badge: which ping this session is waiting on you for, until opened.
      attention: getAttention(s.id)?.kind || null,
      muted: isMutedById(s.id),
    }));

  // Newest activity first — the client buckets by day, like the app. Every row
  // reaching here is connected by construction, but filter explicitly so that
  // invariant holds even if a future source doesn't pre-filter.
  const sessions = [...harness, ...remote]
    .filter((s) => s.connected)
    .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  res.json({ sessions });
});

router.post('/', async (req, res) => {
  try {
    const kind = req.body?.kind === 'shell' ? 'shell' : 'claude';
    const base = getConfig('mobile_base_dir', 'C:\\AI');
    // cwd optional: defaults to the projects base (handy for phone shell sessions).
    // Strip quotes (Windows paths can't contain them) — users often type/dictate
    // a shell-style quoted path like C:\AI\'voice harness'.
    const rawCwd = (req.body?.cwd || '').trim().replace(/["']/g, '') || base;
    const cwd = resolve(rawCwd); // normalize slashes + make absolute (Windows-safe)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `folder not found: ${cwd}` });
    }
    const label = req.body?.label || null;
    // A localhost request is the desktop app on the PC (in the harness); anything
    // else reached us over Tailscale with a bearer token (remote control).
    const origin = isLocalhost(req) ? 'harness' : 'remote';
    const session = await createSession({ cwd, label, kind, origin });
    res.status(201).json(session);
  } catch (err) {
    log.error(`create session error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Open Claude's background-agent view in a pty so the phone can attach to (or peek)
// a live background agent — those reject `claude --resume`. The phone drives the view
// with the ⋯ keys (↑/↓ to the row, Enter = attach, Space = peek); on Enter the same
// pty becomes the agent's live session. cwd only sets where the view is spawned.
router.post('/agent-view', async (req, res) => {
  try {
    const base = getConfig('mobile_base_dir', 'C:\\AI');
    const rawCwd = (req.body?.cwd || '').trim().replace(/["']/g, '');
    // The agent's own cwd may be a worktree that's since been removed; fall back to
    // the projects base so the view still opens (it lists every agent regardless).
    const cwd = rawCwd && existsSync(rawCwd) && statSync(rawCwd).isDirectory() ? resolve(rawCwd) : base;
    const label = req.body?.label || null;
    const origin = isLocalhost(req) ? 'harness' : 'remote';
    const session = await createSession({ cwd, label, kind: 'claude', agentView: true, origin });
    res.status(201).json(session);
  } catch (err) {
    log.error(`agent-view error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// The label we stored when the session was opened is a snapshot: a new session gets
// the folder name, a resumed one gets the archived transcript's title. Claude Code
// re-titles a session as the conversation moves on, so that snapshot drifts and the
// header ends up naming a session you're no longer in. Claude's own list carries the
// current title — match this PTY to it through the bridge suffix -> transcript uuid.
// codeSessions() is a cached, non-blocking read, so this is cheap enough to poll.
function liveTitle(session) {
  if (!session?.claude_session_id) return null;
  const bridges = bridgeSuffixMap();
  // A reconnect spawns a fresh app session over the SAME transcript, so one uuid can
  // carry several titles — a stale folder name ("voice") alongside the current
  // generated one. Take every code-session bridged to this transcript and pick the
  // live one: connected first, then most recently active, so the header shows the
  // title Claude is using right now rather than whichever happened to be listed first.
  const matches = codeSessions().filter(
    (s) => s.title && bridges.get(s.suffix)?.sessionId === session.claude_session_id
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (b.connected - a.connected) || (Date.parse(b.ts || 0) - Date.parse(a.ts || 0)));
  return matches[0].title;
}

router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const title = liveTitle(session);
  if (title && title !== session.label) {
    renameSession(session.id, title); // persist, so the Sessions list agrees with the header
    session.label = title;
  }
  // Viewing a session is acknowledging its ping — clear the sticky badge. SessionView
  // polls this every 5s while open, so the badge drops the moment you're looking.
  clearAttention(session.id);
  res.json({ ...session, muted: isMutedById(session.id) });
});

// Silence (or unsilence) phone push for one session. The badge still shows; only
// the notification is suppressed. Persisted, so it survives reconnects.
router.post('/:id/mute', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const muted = setMutedById(session.id, req.body?.muted !== false);
  res.json({ muted });
});

router.get('/:id/history', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const interactions = selHistory.all(Number(req.params.id)).map((r) => ({
    id: r.id,
    direction: r.direction,
    text: r.text,
    summary: r.summary,
    hasAudio: !!r.audio_path, // never expose the filesystem path
    created_at: r.created_at,
  }));
  res.json({ interactions });
});

// Chat-view conversation log. ?after=<id> returns only newer messages so the
// client can poll incrementally.
router.get('/:id/messages', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const after = Number(req.query.after) || 0;
  const messages = getMessages(req.params.id, after);
  const lastId = messages.length ? messages[messages.length - 1].id : after;
  // `state` lets the chat show a "working…" indicator while Claude is busy.
  res.json({ messages, lastId, state: session.state });
});

// Chat-view send: record the user turn and run it through the completion pipeline
// in the background (types it in, waits, extracts the reply via the Stop hook or a
// screen scrape — the same proven path as /command). The assistant reply is
// recorded when the turn completes and shows up on the next /messages poll.
// Responds immediately so the chat box stays snappy.
router.post('/:id/chat', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  recordUserMessage(session.id, text);
  executeCommand(session, text)
    .then((result) => recordAssistantMessage(session.id, result.text))
    .catch((err) => log.warn(`chat turn failed for db#${session.id}: ${err.message}`));
  res.json({ ok: true });
});

// Send an allowlisted control key to the session (mode-cycle / stop).
router.post('/:id/key', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  const seq = KEY_SEQS[req.body?.key];
  if (!seq) return res.status(400).json({ error: 'unknown key' });
  try {
    sendRawKey(req.params.id, seq);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current interactive picker on screen (question + numbered options), or null.
// Lets a client that arrives mid-prompt (e.g. one opened from terminal-typed input)
// render the choices without having driven the command itself.
router.get('/:id/prompt', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  try {
    const screen = await readScreen(req.params.id, { full: false });
    res.json({ prompt: detectPrompt(screen) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Answer an interactive picker by option number: move the cursor there (reading
// its current position off the screen) and press Enter, then wait for Claude's
// follow-up so the caller can show/speak it. Single-select pickers only — the
// multi-question ones (tabs) are still answered in the terminal.
router.post('/:id/select', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  const index = Number(req.body?.index) | 0;
  const wait = req.body?.wait !== false;
  try {
    const prompt = detectPrompt(await readScreen(req.params.id, { full: false }));
    if (!prompt) return res.status(409).json({ error: 'no interactive prompt on screen' });
    const target = prompt.options.find((o) => o.n === index);
    if (!target) return res.status(400).json({ error: `option ${index} not available` });

    const delta = index - prompt.cursorN;
    const step = delta > 0 ? KEY_SEQS.down : KEY_SEQS.up;
    for (let i = 0; i < Math.abs(delta); i++) {
      sendRawKey(req.params.id, step);
      await sleep(70); // let the TUI redraw between moves
    }

    // Record what was picked so the chat log stays continuous, then submit.
    const label = `▸ ${index}. ${target.label}`;
    recordUserInteraction(session.id, label);
    recordUserMessage(session.id, label);
    markState(session.id, 'busy');
    const sentAt = Date.now();
    sendRawKey(req.params.id, KEY_SEQS.enter);

    if (!wait) return res.json({ ok: true, selected: index });
    const result = await awaitReply(session, getPtyId(session.id), sentAt, 120_000);
    const payload = await buildReplyResponse(session, result, { desktopPlayback: req.body?.desktopPlayback !== false });
    res.json({ ok: true, selected: index, ...payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resize a session's PTY (the phone terminal fits the TUI to its width).
router.post('/:id/resize', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  const cols = Math.max(20, Math.min(200, Number(req.body?.cols) | 0));
  const rows = Math.max(8, Math.min(80, Number(req.body?.rows) | 0));
  if (!cols || !rows) return res.status(400).json({ error: 'cols and rows required' });
  // A resize sends SIGWINCH, which cancels modal operations like /compact. Skip
  // auto-fit while a command is running (e.g. re-opening the terminal mid-/compact);
  // the terminal re-fits once the turn finishes. terminal.resize is also idempotent.
  if (session.state === 'busy') return res.json({ ok: true, skipped: 'busy' });
  try {
    resizeSession(req.params.id, cols, rows);
    res.json({ ok: true, cols, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current permission mode, read off the TUI footer.
router.get('/:id/mode', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  try {
    const screen = await readScreen(req.params.id, { full: false });
    res.json({ mode: detectMode(screen) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attachment upload: store the file under a safe name and return its local path
// so the client can drop it into the message (Claude Code reads local paths).
router.post('/:id/attach', upload.single('file'), (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const ext = extname(req.file.originalname || '').toLowerCase();
  if (!ATTACH_EXT.has(ext)) return res.status(415).json({ error: `unsupported type: ${ext || '?'}` });
  try {
    const name = `att-${Date.now()}-${attachCounter++}${ext}`;
    const dest = join(UPLOADS_DIR, name);
    writeFileSync(dest, req.file.buffer);
    res.status(201).json({ path: dest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw terminal input (shell navigation from the phone).
router.post('/:id/input', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  try {
    await sendInput(req.params.id, req.body?.text || '', { submit: req.body?.submit !== false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rendered screen. ?full=1 returns the whole scrollback (session history);
// otherwise just the current viewport. Also returns the best-guess cwd.
router.get('/:id/screen', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  try {
    const full = req.query.full === '1' || req.query.full === 'true';
    const color = req.query.color === '1' || req.query.color === 'true';
    const screen = await readScreen(req.params.id, { full });
    const resp = { screen, promptCwd: parsePromptCwd(screen) };
    if (color) resp.html = await readScreenColored(req.params.id, { full });
    res.json(resp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch Claude Code inside a shell session, then treat it as a claude session.
router.post('/:id/launch-claude', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  try {
    await sendInput(req.params.id, 'claude', { submit: true });
    setKind(req.params.id, 'claude');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/kill', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  killSession(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/rename', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const label = (req.body?.label || '').trim() || null;
  res.json(renameSession(req.params.id, label));
});

// Extract the current directory from the last PowerShell prompt (`PS C:\path>`).
function parsePromptCwd(screen) {
  const matches = [...screen.matchAll(/PS\s+([A-Za-z]:\\[^\n>]*?)>/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

export default router;
