// GET /api/tts/:interactionId — replay the cached TTS mp3 for an interaction.

import { existsSync } from 'node:fs';
import { Router } from 'express';
import db from '../../db.js';

const router = Router();
const sel = db.prepare('SELECT audio_path FROM interactions WHERE id = ?');

router.get('/:interactionId', (req, res) => {
  const row = sel.get(Number(req.params.interactionId));
  if (!row || !row.audio_path || !existsSync(row.audio_path)) {
    return res.status(404).json({ error: 'audio not found' });
  }
  res.type('audio/mpeg');
  res.sendFile(row.audio_path);
});

export default router;
