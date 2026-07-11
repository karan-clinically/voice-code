// GET /api/sessions       — list all known sessions (live + dead)
// GET /api/sessions/:id    — one session

import { Router } from 'express';
import { listSessions, getSession } from '../../services/sessionManager.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ sessions: listSessions() });
});

router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

export default router;
