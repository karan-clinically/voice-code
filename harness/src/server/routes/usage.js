// GET /api/usage/summary — estimated API spend across providers (Deepgram TTS/STT,
// ElevenLabs TTS, OpenAI summaries/cleanup), for the header spend tally.

import { Router } from 'express';
import { usageSummary } from '../../services/usage.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('usage-route');
const router = Router();

router.get('/summary', (req, res) => {
  try {
    res.json(usageSummary());
  } catch (err) {
    log.warn(`usage summary failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
