// POST /api/transcribe — multipart audio (field "audio") -> { text }.
// STT only (PhoneWhisper "dictate into a field" mode). The OpenAI key stays
// server-side.

import { Router } from 'express';
import multer from 'multer';
import { transcribe } from '../../services/whisper.js';
import { refineTranscript } from '../../services/refine.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('transcribe');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
const router = Router();

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no audio file in field "audio"' });
    const raw = (
      await transcribe(req.file.buffer, req.file.originalname || 'audio.wav', {
        language: req.body.language,
      })
    ).trim();
    // Optional Wispr-style dictation cleanup (desktop push-to-talk sets this) so
    // the text dropped at the prompt reads as a clean instruction, not raw ASR.
    const wantCleanup = req.body.cleanup === 'true' || req.body.cleanup === true || req.query.cleanup === '1';
    const text = wantCleanup && raw ? await refineTranscript(raw) : raw;
    res.json({ text, raw, cleaned: text !== raw });
  } catch (err) {
    log.error(`transcribe error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
