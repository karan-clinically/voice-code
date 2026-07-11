// POST /api/command — the voice pipeline. Accepts JSON {text, sessionId} or
// multipart audio + sessionId. Flow: (STT if audio) -> type into session ->
// wait for completion -> record interactions -> return response. Summary + TTS
// are added in step 8.

import { Router } from 'express';
import multer from 'multer';
import db from '../../db.js';
import { getSession } from '../../services/sessionManager.js';
import { executeCommand } from '../../services/claudeCode.js';
import { transcribe } from '../../services/whisper.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('command');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
const router = Router();

const insertInteraction = db.prepare(
  'INSERT INTO interactions (session_id, direction, text, summary, audio_path) VALUES (?, ?, ?, ?, ?)'
);

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (!session.alive) return res.status(409).json({ error: 'session is not alive' });

    let transcript = (req.body.text || '').trim();
    if (!transcript && req.file) {
      transcript = (await transcribe(req.file.buffer, req.file.originalname || 'audio.wav')).trim();
    }
    if (!transcript) return res.status(400).json({ error: 'no text or audio provided' });

    insertInteraction.run(session.id, 'user', transcript, null, null);

    const result = await executeCommand(session, transcript);

    const claudeRow = insertInteraction.run(session.id, 'claude', result.text, null, null);

    res.json({
      transcript,
      responseText: result.text,
      summary: null, // step 8
      audioUrl: null, // step 8
      interactionId: Number(claudeRow.lastInsertRowid),
      via: result.via,
      stopReason: result.stopReason,
    });
  } catch (err) {
    log.error(`command error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
