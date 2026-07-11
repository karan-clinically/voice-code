// GET  /api/voices          — list ElevenLabs voices (needs saved key)
// POST /api/voices/preview   — synthesize a sample, return audio/mpeg bytes
// Localhost-only.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { getConfig } from '../../config.js';
import { listVoices, synthesize } from '../../services/elevenlabs.js';

const router = Router();
router.use(localhostOnly);

router.get('/', async (req, res) => {
  try {
    res.json({ voices: await listVoices() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const voiceId = req.body?.voiceId || getConfig('elevenlabs_voice_id');
    const text = req.body?.text || 'Hello. The voice harness is configured and working.';
    const audio = await synthesize(text, voiceId);
    res.type('audio/mpeg');
    res.sendFile(audio.path);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
