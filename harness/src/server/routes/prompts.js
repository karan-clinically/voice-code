// Global saved-prompt snippets for the chat composer's "/" picker.
//   GET    /api/prompts        — list, newest first
//   POST   /api/prompts {text,label?}
//   DELETE /api/prompts/:id
// Standard auth (localhost bypass / bearer token) — the phone reaches this too.

import { Router } from 'express';
import db from '../../db.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('prompts');
const router = Router();

const selAll = db.prepare('SELECT id, text, label, created_at FROM saved_prompts ORDER BY id DESC');
const insert = db.prepare('INSERT INTO saved_prompts (text, label) VALUES (?, ?)');
const del = db.prepare('DELETE FROM saved_prompts WHERE id = ?');

router.get('/', (req, res) => {
  res.json({ prompts: selAll.all() });
});

router.post('/', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const label = (req.body?.label || '').trim() || null;
  const info = insert.run(text.slice(0, 8000), label ? label.slice(0, 120) : null);
  res.status(201).json({ id: Number(info.lastInsertRowid), text, label });
});

router.delete('/:id', (req, res) => {
  del.run(Number(req.params.id));
  res.json({ ok: true });
});

export default router;
