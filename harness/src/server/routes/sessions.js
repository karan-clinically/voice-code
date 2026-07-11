// GET  /api/sessions        — list all known sessions (live + dead)
// GET  /api/sessions/:id     — one session
// POST /api/sessions         — spawn a new Claude Code session {cwd, label}
// POST /api/sessions/:id/kill — terminate a session
// POST /api/sessions/:id/rename — set label {label}
//
// The spawn model (node-pty) means sessions are created here, unlike the plan's
// tmux model where sessions were discovered from an external multiplexer.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import db from '../../db.js';
import { getConfig } from '../../config.js';
import {
  listSessions, getSession, createSession, killSession, renameSession,
  sendInput, readScreen, setKind,
} from '../../services/sessionManager.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('sessions-route');
const router = Router();

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
    const rawCwd = (req.body?.cwd || '').trim() || base;
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
    const screen = await readScreen(req.params.id, { full });
    res.json({ screen, promptCwd: parsePromptCwd(screen) });
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
