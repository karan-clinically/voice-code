// GET  /api/sessions        — list all known sessions (live + dead)
// GET  /api/sessions/:id     — one session
// POST /api/sessions         — spawn a new Claude Code session {cwd, label}
// POST /api/sessions/:id/kill — terminate a session
// POST /api/sessions/:id/rename — set label {label}
//
// The spawn model (node-pty) means sessions are created here, unlike the plan's
// tmux model where sessions were discovered from an external multiplexer.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import db, { UPLOADS_DIR } from '../../db.js';
import { getConfig } from '../../config.js';
import {
  listSessions, getSession, createSession, killSession, renameSession, setTabColor,
  sendInput, sendRawKey, resizeSession, readScreen, readScreenColored, readScreenColoredPage, setKind,
  getPtyId, markState, reusableSession, recordReuse, setModel, setClaudeSessionId,
  latestSessionByClaudeId,
} from '../../services/sessionManager.js';
import { MODEL_OPTIONS } from '../../services/models.js';
import { isLocalhost } from '../auth.js';
import { getArchiveMeta, findArchiveByTitle } from '../../services/archiveIndex.js';
import { bridgeSuffixMap, liveClaudeSessions } from '../../services/claudeSessions.js';
import { isBackgroundAgentSession, processForHarnessSession } from '../../services/sessionIdentity.js';
import { codeSessions } from '../../services/codeSessions.js';
import { backgroundAgents } from '../../services/agentRegistry.js';
import { listGrokConversations, getGrokMeta, deleteGrokConversation, isGrokConvId } from '../../services/grokArchive.js';
import { getRemoteSlug } from '../../services/terminal.js';
import { getAttention, clearAttention, isMutedById, setMutedById } from '../../services/attention.js';
import { getLiveConversation, getConversationPage, recordUserMessage, recordAssistantMessage } from '../../services/conversation.js';
import { executeCommand, awaitReply } from '../../services/claudeCode.js';
import { detectPrompt } from '../../services/prompt.js';
import { buildReplyResponse, recordUserInteraction } from '../../services/reply.js';
import { makeLogger } from '../../util/logger.js';
import { getAdapter } from '../../agents/registry.js';

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
// Normalised path for equality (Windows: case-insensitive, no trailing slash).
const norm = (p) => (p ? resolve(p) : '').replace(/[\\/]+$/, '').toLowerCase();
const AGENT_LABELS = { claude: 'Claude', grok: 'Grok', codex: 'Codex', shell: 'Shell' };
const GROK_AGENT = fileURLToPath(new URL('../../agents/grokAgent.js', import.meta.url));
const psQuote = (s) => String(s).replace(/`/g, '``').replace(/"/g, '`"');

function normalizeKind(raw) {
  const id = String(raw || 'claude').trim().toLowerCase();
  if (!getAdapter(id)) throw new Error(`unknown AI CLI provider: ${id}`);
  return id;
}

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

// The phone's Sessions list. Every row is one of two kinds, and the difference is
// the whole architecture:
//
//   ATTACHABLE — a harness-owned pty. The harness owns the claude process, so the
//     phone, the terminal (hclaude) and Claude remote control all drive the SAME
//     session (a harness pty registers itself with claude.ai as a `bridge` too).
//     Tapping it ATTACHES in place. No fork, ever.
//   ELSEWHERE — a session the harness does NOT own (started outside hclaude, a cloud
//     session, a background agent). It can't be attached to; the only lever is
//     `claude --resume`, which BRANCHES into a new conversation. The client makes
//     that explicit rather than forking silently.
//
// Identity rule (learned the hard way): the bridge-suffix -> transcript-uuid map is a
// real 1:1 link and is the ONLY thing allowed to decide identity, dedupe or liveness.
// Matching a session by TITLE is a guess — a folder full of sessions named "voice"
// all collapse onto one transcript — so a title match may only enrich openability,
// where being wrong offers a bad resume target instead of deleting a live session.
router.get('/recent', (req, res) => {
  const bridges = bridgeSuffixMap(); // bridge suffix -> local transcript (EXACT link)
  const bgList = [...backgroundAgents().values()]; // live background agents (reject --resume)

  // The API leaves stale "connected" records behind after a bridge dies, so it
  // over-reports. The reliable signal is a running claude.exe (pid vs tasklist).
  const live = liveClaudeSessions();
  const processByPid = new Map(live.map((process) => [Number(process.pid), process]));
  const liveSuffixes = new Set(live.filter((x) => x.suffix).map((x) => x.suffix));
  const liveUuids = new Set(live.map((x) => x.sessionId).filter(Boolean));

  // "Reachable from claude.ai remote control" has ONE reliable signal: the running
  // claude registered a bridge (`bridgeSessionId`) with claude.ai. A plain `claude`
  // in a terminal has no bridge, so the harness surfaces it here but claude.ai can't
  // see it. The phone drives every row it lists regardless; this flag only says
  // whether the SAME session also appears in claude.ai remote control.
  // ---- ATTACHABLE: harness-owned PTYs (the source of truth; tap = attach) ----
  // A pty opened to peek a background agent lives in that agent's worktree; it's the
  // same work as the agent's own row (whose tap reuses this very pty), so skip it.
  const backgroundUuids = new Set(bgList.map((agent) => agent.sessionId).filter(Boolean));
  const harness = listSessions()
    .filter((s) => s.alive)
    // Agent-view PTYs are marked when spawned. Never infer this from cwd: a stale
    // background agent at C:\AI previously hid every ordinary session in C:\AI.
    .filter((s) => !s.agentView)
    .map((s) => {
      // The Stop hook can leave the DB row carrying an older conversation UUID
      // after `claude --continue` or a reconnect changes the live process's
      // transcript. The PTY's process id is an exact identity link to Claude's
      // ~/.claude/sessions registry, so prefer it over the stored snapshot. This
      // also lets the remote-control API twin dedupe immediately at startup.
      const processSession = s.kind === 'claude' && s.pid
        ? processByPid.get(Number(s.pid)) || processForHarnessSession(s, live)
        : null;
      const sessionId = processSession?.sessionId || s.claude_session_id || null;
      const remote = !!processSession?.bridged;
      if (processSession?.sessionId && processSession.sessionId !== s.claude_session_id) {
        setClaudeSessionId(s.id, processSession.sessionId);
      }
      return {
      key: 'h' + s.id,
      kind: 'harness',
      attachable: true, // drivable from phone + terminal + Claude remote control
      name: s.label || baseName(s.cwd) || `Session ${s.id}`,
      connected: true,
      active: s.state === 'busy',
      unread: false,
      origin: s.origin === 'remote' ? 'phone' : 'pc',
      originLabel: s.origin === 'remote' ? 'Phone' : 'This PC',
      shell: s.kind === 'shell',
      agentKind: s.kind || 'claude',
      agentLabel: AGENT_LABELS[s.kind || 'claude'] || s.kind || 'Claude',
      repo: repoSlug(s.cwd) || s.git_repo || null,
      branch: s.git_branch || null,
      cwd: s.cwd || null,
      sessionId,
      ts: s.last_seen_at,
      harnessId: s.id,
      alive: true,
      // On claude.ai only once its Claude has bridged. Shell/Grok sessions are
      // local harness PTYs and are reachable through Voice Harness/Tailscale only.
      remote: s.kind === 'claude' && remote,
      remoteReason:
        s.kind === 'shell'
          ? 'A shell runs only on this PC — remote control is for Claude sessions.'
          : s.kind === 'grok'
          ? 'Grok runs inside this harness PTY using Voice Harness tools and is reachable from the phone via Voice Harness/Tailscale, not claude.ai remote control.'
          : s.kind === 'codex'
          ? 'Codex runs inside this harness PTY using the OpenAI Codex CLI and is reachable from the phone via Voice Harness/Tailscale, not claude.ai remote control.'
          : remote
          ? null
          : 'Started on this PC and not yet bridged to claude.ai, so it only shows here. You can drive it from the app; it appears in claude.ai remote control once its bridge connects.',
      // Sticky badge: which ping this session is waiting on you for, until opened.
      attention: getAttention(s.id)?.kind || null,
      muted: isMutedById(s.id),
      };
    })
    // Two harness PTYs can land on the SAME conversation — e.g. the phone resumed it
    // and a terminal `claude -c` continued it. That's one conversation, so show one
    // row (the most recently active). A session with no uuid yet can't be matched, so
    // it passes through. The duplicate PROCESS is prevented in POST / below; this just
    // keeps the list honest if one slips through.
    .reduce((acc, r) => {
      if (!r.sessionId) return acc.concat(r);
      const prev = acc.find((x) => x.sessionId === r.sessionId);
      if (!prev) return acc.concat(r);
      if (Date.parse(r.ts || 0) > Date.parse(prev.ts || 0)) Object.assign(prev, r);
      return acc;
    }, []);
  const harnessUuids = new Set(harness.map((h) => h.sessionId).filter(Boolean));

  // ---- ELSEWHERE: sessions the harness doesn't own (tap = explicit branch) ----
  const remote = collapseGhosts(codeSessions()
    .filter((s) => s.connected)
    .map((s) => {
      // EXACT identity only. No title guessing on this path.
      const local = bridges.get(s.suffix) || null;
      const linkUuid = local?.sessionId || null;

      const bg = bgList.find((a) => (linkUuid && a.sessionId === linkUuid) || (s.title && a.name === s.title)) || null;
      // A background agent is only worth a row while it's still running AND unfinished.
      if (bg && (bg.state === 'done' || !bg.sessionId || !liveUuids.has(bg.sessionId))) return null;

      // Openability enrichment — a title match is allowed here ONLY. Being wrong costs
      // a bad resume target; it can never remove a live row.
      let meta = linkUuid ? getArchiveMeta(linkUuid) : null;
      if (!meta && s.envKind !== 'anthropic_cloud' && s.title) meta = findArchiveByTitle(s.title);
      const openUuid = linkUuid || meta?.uuid || null;

      // Liveness gate: keep only what a running claude.exe backs. Suffix (exact) first;
      // openUuid can only ADD a live-but-unbridged session back, never remove one.
      if (!(s.envKind === 'anthropic_cloud' || bg || liveSuffixes.has(s.suffix) || (openUuid && liveUuids.has(openUuid)))) {
        return null;
      }
      // The harness already owns this conversation and lists it as ATTACHABLE — drop
      // the redundant API twin so one session is one row.
      if (openUuid && harnessUuids.has(openUuid)) return null;

      const cwd = local?.cwd || meta?.cwd || null;
      // A conversation the harness itself started (phone/PC) can reappear on this
      // path purely via its still-live claude.ai bridge after its PTY died. Recognise
      // it by UUID so it keeps the Phone/PC badge and its real title instead of
      // reading as an anonymous "Remote control" row — otherwise you can't pick your
      // own sessions out of the list. Not for background agents (they own their badge).
      const owned = !bg && openUuid ? latestSessionByClaudeId(openUuid) : null;
      const ownedOrigin = owned && owned.origin === 'remote' ? 'phone'
        : owned && owned.origin === 'harness' ? 'pc' : null;
      return {
        key: 'c' + s.id,
        kind: 'code',
        attachable: false, // harness can't attach — opening it BRANCHES the conversation
        name: bg?.name || (ownedOrigin && owned.label) || s.title || (openUuid ? openUuid.slice(0, 8) : s.suffix.slice(0, 8)),
        connected: s.connected,
        active: bg ? bg.state === 'working' : s.working,
        unread: s.unread,
        origin: ownedOrigin || (s.envKind === 'anthropic_cloud' ? 'cloud' : 'terminal'),
        originLabel: bg ? 'Background agent'
          : ownedOrigin === 'phone' ? 'Phone'
          : ownedOrigin === 'pc' ? 'This PC'
          : s.envKind === 'anthropic_cloud' ? 'Cloud' : 'Remote control',
        repo: s.repo || repoSlug(bg?.cwd || cwd) || null,
        branch: s.branch || meta?.gitBranch || null,
        cwd: bg?.cwd || cwd,
        sessionId: openUuid,
        ts: s.ts,
        bgAgent: !!bg, // route the tap to the agent view (attach/peek) not --resume
        agentCwd: bg?.cwd || null,
        resumeUuid: bg ? null : meta?.cwdExists ? openUuid : null,
        // These come FROM the claude.ai API, so they're on remote control by
        // definition (a bridged terminal or a cloud session).
        remote: true,
        remoteReason: null,
      };
    }).filter(Boolean));

  // ---- LOCAL: a live claude nobody else surfaced ----
  // A claude running in a terminal that is neither harness-owned NOR bridged to remote
  // control appears in neither source above, so it's invisible — and a session
  // "vanishes" the moment its bridge drops even though the process is still running.
  // Surface those from the pid-backed live list so a running session is always shown.
  // Not attachable (the harness doesn't own it), so a tap branches like any other
  // remote row. Deduped against everything already shown, by transcript uuid.
  const shownUuids = new Set([...harness, ...remote].map((r) => r.sessionId).filter(Boolean));
  const local = live
    .filter((s) => s.sessionId && !shownUuids.has(s.sessionId))
    // Exact UUID only. A background agent and an interactive session may share cwd.
    .filter((s) => !isBackgroundAgentSession(s, backgroundUuids))
    // Two processes can share a uuid (a fork's leftover); show one, freshest.
    .reduce((acc, s) => {
      const prev = acc.find((x) => x.sessionId === s.sessionId);
      if (!prev) return acc.concat(s);
      if ((s.updatedAt || 0) > (prev.updatedAt || 0)) acc[acc.indexOf(prev)] = s;
      return acc;
    }, [])
    .map((s) => {
      const meta = getArchiveMeta(s.sessionId);
      const cwd = s.cwd || meta?.cwd || null;
      return {
        key: 'l' + s.pid,
        kind: 'code',
        local: true, // a bare terminal claude — killable by pid via /kill-local
        pid: s.pid,
        attachable: false, // not harness-owned — opening it BRANCHES the conversation
        name: meta?.title || s.name || s.sessionId.slice(0, 8),
        connected: true,
        active: s.status === 'busy',
        unread: false,
        origin: 'terminal',
        originLabel: 'Terminal',
        repo: repoSlug(cwd) || null,
        branch: meta?.gitBranch || null,
        cwd,
        sessionId: s.sessionId,
        ts: new Date(s.updatedAt || Date.now()).toISOString(),
        bgAgent: false,
        agentCwd: null,
        resumeUuid: meta?.cwdExists ? s.sessionId : null,
        // A bridged terminal would have surfaced in the API bucket above; anything
        // landing here is a plain `claude` with no bridge, so claude.ai can't see it.
        remote: !!s.bridged,
        remoteReason: s.bridged
          ? null
          : "This Claude is running in a terminal without remote control connected, so it only appears here. Start it through the harness (hclaude), or turn on remote control in that terminal, to reach it from claude.ai.",
      };
    });

  // ---- SAVED GROK: a native Grok conversation whose PTY is gone ----
  // Grok isn't a Claude transcript, so it never appears in History; its saved
  // context file is the only record. Surface each one that isn't currently live as a
  // resumable row (tap = reopen a Grok PTY with its memory restored). A live Grok
  // session already shows in the harness bucket (its conv id is in harnessUuids).
  const grokSaved = listGrokConversations()
    .filter((c) => !harnessUuids.has(c.id))
    .map((c) => ({
      key: 'g' + c.id,
      kind: 'grok-saved',
      attachable: false, // harness spawns a fresh PTY that loads the saved context
      resumeGrok: c.id,
      name: c.title,
      connected: false,
      active: false,
      unread: false,
      origin: 'saved',
      originLabel: 'Saved Grok conversation',
      agentKind: 'grok',
      agentLabel: 'Grok',
      repo: repoSlug(c.cwd) || null,
      branch: null,
      cwd: c.cwd,
      sessionId: c.id,
      ts: c.updatedAt,
      remote: false,
      remoteReason: 'A saved Grok conversation — tap to resume it here with its memory restored.',
    }));

  // Newest first — the client buckets by day like the Claude app.
  const sessions = [...harness, ...remote, ...local, ...grokSaved].sort(
    (a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0)
  );
  res.json({ sessions });
});

// Kill a bare-terminal ("local") claude by pid — the phone's swipe-to-kill on a
// local session row. The harness doesn't own these, so /:id/kill can't reach them.
// Two guards make this safe: the pid must be one the live registry currently reports
// as a running claude (never an arbitrary process), and it must be UNbridged — a
// bridged session is one you're actively driving (incl. this very conversation), so
// it's off-limits. /T tears down the session's own child processes with it.
// Forget a saved Grok conversation. A `grok-saved` row is backed by a context file,
// not a process, so /:id/kill and swipe-to-kill can't touch it — without this it is a
// card you can never clear. Refuses while the conversation is live: its PTY owns the
// file and would write it straight back. Registered before '/:id' so that route (a
// numeric db id) can't swallow the path.
router.delete('/grok/:id', (req, res) => {
  const id = req.params.id;
  if (!isGrokConvId(id)) return res.status(400).json({ error: 'not a conversation id' });
  const live = listSessions().find((s) => s.alive && s.kind === 'grok' && s.claude_session_id === id);
  if (live) return res.status(409).json({ error: 'conversation is live — close its session first' });
  if (!deleteGrokConversation(id)) return res.status(404).json({ error: 'saved conversation not found' });
  res.json({ ok: true, id });
});

router.post('/kill-local', (req, res) => {
  const pid = Number(req.body?.pid) | 0;
  if (!pid) return res.status(400).json({ error: 'pid required' });
  const sess = liveClaudeSessions().find((s) => s.pid === pid);
  if (!sess) return res.status(404).json({ error: 'no live claude session with that pid' });
  if (sess.bridged) return res.status(409).json({ error: 'session is bridged/active — not killable here' });
  execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err) => {
    if (err) return res.status(500).json({ error: `taskkill failed: ${err.message}` });
    log.info(`killed local claude pid ${pid} (${sess.cwd || '?'})`);
    res.json({ ok: true, pid });
  });
});

router.post('/', async (req, res) => {
  try {
    const kind = normalizeKind(req.body?.providerId || req.body?.kind);
    const base = getConfig('mobile_base_dir', 'C:\\AI');

    // Resume a saved Grok conversation: reopen a Grok PTY bound to the same conv id
    // so the agent reloads its context file. Reuse a live/already-opened one instead
    // of stacking PTYs. The cwd comes from the saved conversation.
    const resumeGrok = (req.body?.resumeGrok || '').trim() || null;
    if (resumeGrok) {
      const meta = getGrokMeta(resumeGrok);
      if (!meta) return res.status(404).json({ error: 'saved Grok conversation not found' });
      const openLive = listSessions().find(
        (s) => s.alive && s.kind === 'grok' && s.claude_session_id === resumeGrok
      );
      if (openLive) return res.json(openLive); // already live — attach in place
      const reuseKey = `grok:${resumeGrok}`;
      const existing = reusableSession(reuseKey);
      if (existing) return res.json(existing);
      // The saved cwd may have been moved/deleted since; node-pty throws on a missing
      // spawn dir, so fall back to the projects base (the conversation still resumes).
      const savedCwd = resolve((meta.cwd || base).replace(/["']/g, ''));
      const grokCwd = existsSync(savedCwd) && statSync(savedCwd).isDirectory() ? savedCwd : resolve(base);
      const origin = isLocalhost(req) ? 'harness' : 'remote';
      const session = await createSession({ cwd: grokCwd, label: meta.title, kind: 'grok', grokConv: resumeGrok, origin });
      recordReuse(reuseKey, session.id);
      return res.status(201).json(session);
    }

    // cwd optional: defaults to the projects base (handy for phone shell sessions).
    // Strip quotes (Windows paths can't contain them) — users often type/dictate
    // a shell-style quoted path like C:\AI\'voice harness'.
    const rawCwd = (req.body?.cwd || '').trim().replace(/["']/g, '') || base;
    const cwd = resolve(rawCwd); // normalize slashes + make absolute (Windows-safe)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `folder not found: ${cwd}` });
    }
    const label = req.body?.label || null;
    // `claude --continue` (from the hclaude alias) → a harness-owned session that
    // resumes the most-recent conversation in cwd, so terminal + phone share it.
    const continueSession = req.body?.continue === true;
    // Callers opening an existing item may omit forceNew and attach to the freshest
    // matching PTY. Explicit "New session" actions set forceNew so several coding
    // sessions can intentionally work in the same directory at once.
    const forceNew = req.body?.forceNew === true;
    if (!forceNew) {
      const open = listSessions()
        .filter((s) => s.alive && s.kind === kind && s.cwd && norm(s.cwd) === norm(cwd))
        .sort((a, b) => Date.parse(b.last_seen_at || 0) - Date.parse(a.last_seen_at || 0))[0];
      if (open) return res.json(open); // 200 = reused, not created
    }
    // A localhost request is the desktop app on the PC (in the harness); anything
    // else reached us over Tailscale with a bearer token (remote control).
    const origin = isLocalhost(req) ? 'harness' : 'remote';
    const session = await createSession({
      cwd,
      label,
      providerId: kind,
      externalSessionId: req.body?.externalSessionId || null,
      credentialRef: req.body?.credentialRef || null,
      continueSession,
      origin,
    });
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

    // Reuse an agent view you already opened for this agent instead of spawning
    // another every tap. Keyed by cwd — a background agent runs in its own
    // worktree, so cwd uniquely identifies it. Falls back to adopting the freshest
    // live session already at that cwd (taps made before this dedup existed).
    const key = `agent:${norm(cwd)}`;
    let existing = reusableSession(key);
    if (!existing) {
      existing = listSessions()
        .filter((s) => s.alive && s.kind === 'claude' && norm(s.cwd) === norm(cwd))
        .sort((a, b) => Date.parse(b.last_seen_at || 0) - Date.parse(a.last_seen_at || 0))[0] || null;
    }
    if (existing) {
      recordReuse(key, existing.id);
      return res.json(existing);
    }

    const session = await createSession({ cwd, label, kind: 'claude', agentView: true, origin });
    recordReuse(key, session.id);
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
  if (title && !session.title_locked && title !== session.label) {
    renameSession(session.id, title, { locked: false }); // persist, so the Sessions list agrees with the header
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

// Chat-view conversation log. Prefers the LIVE on-disk transcript (the complete
// record Claude Code writes as it runs — every text block, every turn, even one
// driven from another device) and falls back to the harness `messages` table.
// `full:true` marks a whole-conversation snapshot the client replaces; otherwise
// ?after=<id> returns only newer table rows for incremental append.
router.get('/:id/messages', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (req.query.limit != null || req.query.before != null) {
    const page = await getConversationPage(session, {
      before: req.query.before,
      limit: req.query.limit,
    });
    return res.json({ ...page, state: session.state });
  }
  const after = Number(req.query.after) || 0;
  const conv = await getLiveConversation(session, after);
  // `state` lets the chat show a "working…" indicator while Claude is busy.
  res.json({ ...conv, state: session.state });
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
  // Named key, or a short raw sequence — the phone's fallback when its /ws/term key
  // channel is down (harness restart, zombie socket), so answering a prompt still
  // works instead of the keystroke silently vanishing. Same trust level as the raw
  // WS channel: both arrive through auth.js (localhost or bearer token).
  const raw = typeof req.body?.seq === 'string' && req.body.seq.length > 0 && req.body.seq.length <= 32;
  const seq = KEY_SEQS[req.body?.key] || (raw ? req.body.seq : null);
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

// Switch the session's model. `session.model` (from listSessions/getSession)
// already carries the current value — set optimistically here, then corrected
// once Claude's own confirmation line lands (see sessionManager.js).
router.post('/:id/model', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  if (session.kind !== 'claude') return res.status(400).json({ error: 'model switching is Claude-only' });
  const opt = MODEL_OPTIONS.find((m) => m.alias === req.body?.alias);
  if (!opt) return res.status(400).json({ error: 'unknown model' });
  try {
    await sendInput(req.params.id, `/model ${opt.alias}`, { submit: true });
    setModel(req.params.id, opt.label);
    res.json({ ok: true, model: opt.label });
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
    const includePlain = req.query.plain !== '0' && req.query.plain !== 'false';
    const paged = req.query.lines != null || req.query.before != null;
    let screen = null;
    let promptScreen;
    if (includePlain) {
      screen = await readScreen(req.params.id, { full });
      promptScreen = full ? await readScreen(req.params.id, { full: false }) : screen;
    } else {
      // Colored mobile view does not consume the duplicate plain-text scrollback.
      // Capture only the small viewport needed for cwd detection.
      promptScreen = await readScreen(req.params.id, { full: false });
    }
    const resp = { promptCwd: parsePromptCwd(promptScreen) };
    if (includePlain) resp.screen = screen;
    // Full view = a real terminal's worth of scrollback, not just the last screen.
    // Keep the cap aligned with terminal.js's larger resume scrollback so historical
    // transcript seed text is actually reachable from the phone.
    if (color && paged) {
      Object.assign(resp, await readScreenColoredPage(req.params.id, {
        before: req.query.before == null ? null : req.query.before,
        limit: req.query.lines,
      }));
    } else if (color) {
      resp.html = await readScreenColored(req.params.id, { full, maxLines: full ? 20000 : 600 });
    }
    res.json(resp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Provider-neutral shell handoff. A new provider-owned PTY is spawned in the
// shell's current directory and the navigation shell is closed. This keeps
// credentials out of visible shell command lines and works for manifest agents
// without teaching this router their executable syntax.
router.post('/:id/launch-provider', async (req, res) => {
  const shell = getSession(req.params.id);
  if (!shell) return res.status(404).json({ error: 'session not found' });
  if (!shell.alive) return res.status(409).json({ error: 'session is not alive' });
  if (shell.kind !== 'shell') return res.status(409).json({ error: 'session is not a navigation shell' });
  let providerId;
  try {
    providerId = normalizeKind(req.body?.providerId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (providerId === 'shell') return res.status(400).json({ error: 'choose an AI CLI provider' });
  try {
    const screen = await readScreen(shell.id, { full: false });
    const cwd = parsePromptCwd(screen) || shell.cwd;
    const adapter = getAdapter(providerId);
    const session = await createSession({
      cwd,
      label: req.body?.label || `${baseName(cwd)} · ${adapter.name}`,
      providerId,
      origin: shell.origin || (isLocalhost(req) ? 'harness' : 'remote'),
    });
    killSession(shell.id);
    res.status(201).json(session);
  } catch (err) {
    log.error(`provider handoff failed: ${err.message}`);
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

// Launch the native Voice Harness Grok coding agent inside a shell session,
// then treat it as a Grok session. The agent inherits the shell's current
// directory as its project root.
router.post('/:id/launch-grok', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  try {
    await sendInput(req.params.id, `$env:CVH_PROJECT_ROOT=(Get-Location).Path; & "${psQuote(process.execPath)}" "${psQuote(GROK_AGENT)}" (Get-Location).Path`, { submit: true });
    setKind(req.params.id, 'grok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch OpenAI Codex CLI inside a shell session, then treat it as a Codex session.
// Codex auth is handled by the CLI itself (ChatGPT/Codex subscription login), not by
// Voice Harness API-key storage.
router.post('/:id/launch-codex', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!session.alive) return res.status(409).json({ error: 'session is not alive' });
  try {
    await sendInput(req.params.id, 'npx -y @openai/codex --yolo', { submit: true });
    setKind(req.params.id, 'codex');
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

router.post('/:id/rename', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const label = String(req.body?.label || '').trim().slice(0, 120) || null;
  const renamed = renameSession(req.params.id, label, { locked: !!label });
  let claudeSynced = false;
  let syncError = null;
  // Claude's supported /rename command updates the prompt bar, local transcript,
  // resume picker, and Remote Control title. The harness label remains useful for
  // non-Claude providers, but shared Claude sessions must carry the name with them.
  if (label && session.kind === 'claude' && session.alive) {
    try {
      await sendInput(req.params.id, `/rename ${label}`);
      claudeSynced = true;
    } catch (err) {
      syncError = err.message;
      log.warn(`Claude title sync failed for db#${session.id}: ${err.message}`);
    }
  }
  res.json({ ...renamed, claudeSynced, syncError });
});

router.post('/:id/color', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const raw = String(req.body?.color || '').trim();
  const color = raw ? (/^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : false) : null;
  if (color === false) return res.status(400).json({ error: 'color must be a 6-digit hex value' });
  res.json(setTabColor(req.params.id, color));
});

// Extract the current directory from the last PowerShell prompt (`PS C:\path>`).
function parsePromptCwd(screen) {
  const matches = [...screen.matchAll(/PS\s+([A-Za-z]:\\[^\n>]*?)>/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

export default router;
