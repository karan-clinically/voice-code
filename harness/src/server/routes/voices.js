// GET  /api/voices?provider=  — list voices for a TTS provider (default: active)
// POST /api/voices/preview     — synthesize a sample, return audio/mpeg bytes
// Localhost-only.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { listVoices, synthesize, activeProviderName } from '../../services/tts/index.js';

const router = Router();
router.use(localhostOnly);

router.get('/', async (req, res) => {
  try {
    const provider = req.query.provider || activeProviderName();
    res.json({ provider, voices: await listVoices(provider) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const text = req.body?.text || 'Hello. The voice harness is configured and working.';
    const audio = await synthesize(text, { provider: req.body?.provider, voiceId: req.body?.voiceId });
    res.type('audio/mpeg');
    res.sendFile(audio.path);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
