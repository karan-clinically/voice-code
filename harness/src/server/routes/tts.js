// GET /api/tts/:interactionId — replay the cached TTS mp3 for an interaction.

import { existsSync } from 'node:fs';
import { Router } from 'express';
import db from '../../db.js';
import { synthesize } from '../../services/tts/index.js';

const router = Router();
const sel = db.prepare('SELECT audio_path FROM interactions WHERE id = ?');

// Speak arbitrary text (used by the phone to read back the current directory).
// Whichever TTS provider is active answers; the phone gets mp3 either way.
router.post('/say', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const audio = await synthesize(text, { voiceId: req.body?.voiceId });
    res.type('audio/mpeg');
    res.sendFile(audio.path);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/:interactionId', (req, res) => {
  const row = sel.get(Number(req.params.interactionId));
  if (!row || !row.audio_path || !existsSync(row.audio_path)) {
    return res.status(404).json({ error: 'audio not found' });
  }
  res.type('audio/mpeg');
  res.sendFile(row.audio_path);
});

export default router;
