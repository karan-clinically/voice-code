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
    const session = await createSession({ cwd, label, kind });
    res.status(201).json(session);
  } catch (err) {
    log.error(`create session error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
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
    const payload = await buildReplyResponse(session, result);
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
