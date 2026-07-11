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
import { listSessions, getSession, createSession, killSession, renameSession } from '../../services/sessionManager.js';
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
    const rawCwd = (req.body?.cwd || '').trim();
    if (!rawCwd) return res.status(400).json({ error: 'cwd is required' });
    const cwd = resolve(rawCwd); // normalize slashes + make absolute (Windows-safe)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: 'cwd is not an existing directory' });
    }
    const label = req.body?.label || null;
    const session = await createSession({ cwd, label });
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

export default router;
