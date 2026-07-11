// POST /api/command — the voice pipeline. Accepts JSON {text, sessionId} or
// multipart audio + sessionId. Flow: (STT if audio) -> type into session ->
// wait for completion -> record interactions -> return response. Summary + TTS
// are added in step 8.

import { Router } from 'express';
import multer from 'multer';
import db from '../../db.js';
import { getConfig } from '../../config.js';
import { getSession } from '../../services/sessionManager.js';
import { executeCommand, summarizeForSpeech } from '../../services/claudeCode.js';
import { transcribe } from '../../services/whisper.js';
import { synthesize } from '../../services/elevenlabs.js';
import { playLocal } from '../../services/audio.js';
import { broadcastResponse } from '../ws.js';
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
    const summary = summarizeForSpeech(result.text);

    // Synthesize spoken summary (best-effort; a TTS failure must not fail the
    // command — the text response is still returned).
    let audioPath = null;
    const voiceId = getConfig('elevenlabs_voice_id');
    if (getConfig('elevenlabs_api_key') && voiceId && summary) {
      try {
        audioPath = (await synthesize(summary, voiceId)).path;
      } catch (err) {
        log.warn(`TTS failed: ${err.message}`);
      }
    }

    const claudeRow = insertInteraction.run(session.id, 'claude', result.text, summary, audioPath);
    const interactionId = Number(claudeRow.lastInsertRowid);

    // Local speaker playback per configured target (fire-and-forget).
    const target = getConfig('tts_playback_target', 'desktop');
    if (audioPath && (target === 'desktop' || target === 'both')) {
      playLocal(audioPath).catch(() => {});
    }

    const audioUrl = audioPath ? `/api/tts/${interactionId}` : null;
    broadcastResponse({ sessionId: session.id, interactionId, summary, audioUrl });

    res.json({
      transcript,
      responseText: result.text,
      summary,
      audioUrl,
      interactionId,
      via: result.via,
      stopReason: result.stopReason,
    });
  } catch (err) {
    log.error(`command error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
