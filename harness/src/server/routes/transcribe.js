// POST /api/transcribe — multipart audio (field "audio") -> { text }.
// STT only (PhoneWhisper "dictate into a field" mode). The OpenAI key stays
// server-side.

import { Router } from 'express';
import multer from 'multer';
import { transcribe } from '../../services/whisper.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('transcribe');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
const router = Router();

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no audio file in field "audio"' });
    const text = await transcribe(req.file.buffer, req.file.originalname || 'audio.wav', {
      language: req.body.language,
    });
    res.json({ text });
  } catch (err) {
    log.error(`transcribe error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
