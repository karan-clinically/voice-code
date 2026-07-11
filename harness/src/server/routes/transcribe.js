// POST /api/transcribe — multipart audio (field "audio") -> { text }.
// Batch STT ("dictate into a field" mode) via Deepgram. The transcript is placed
// into the client's command box for review — it is never injected into a pty
// here. The Deepgram key stays server-side.

import { Router } from 'express';
import multer from 'multer';
import { transcribeBatch } from '../../services/stt/index.js';
import { refineTranscript } from '../../services/refine.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('transcribe');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
const router = Router();

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no audio file in field "audio"' });
    const raw = (
      await transcribeBatch(req.file.buffer, { language: req.body.language })
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
