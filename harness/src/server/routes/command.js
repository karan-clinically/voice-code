// POST /api/command — run text in a session. JSON {text, sessionId} only.
// Flow: type into session -> wait for completion -> record interactions ->
// return response (summary + TTS).
//
// Deliberately text-only: audio never reaches a pty in one hop. Voice goes
// through /api/transcribe (batch) or /ws/stt (live), lands in the client's
// command box for review, and is sent here only when the user presses Send.

import { Router } from 'express';
import db from '../../db.js';
import { getConfig } from '../../config.js';
import { getSession } from '../../services/sessionManager.js';
import { executeCommand, summarizeForSpeech } from '../../services/claudeCode.js';
import { recordUserMessage } from '../../services/conversation.js';
import { synthesize, isConfigured as ttsConfigured } from '../../services/tts/index.js';
import { playLocal } from '../../services/audio.js';
import { broadcastResponse } from '../ws.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('command');
const router = Router();

const insertInteraction = db.prepare(
  'INSERT INTO interactions (session_id, direction, text, summary, audio_path, tts_chars) VALUES (?, ?, ?, ?, ?, ?)'
);

router.post('/', async (req, res) => {
  try {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (!session.alive) return res.status(409).json({ error: 'session is not alive' });

    // The user reviewed this text in the command box and pressed Send.
    const sent = (req.body.text || '').trim();
    if (!sent) return res.status(400).json({ error: 'text is required' });

    insertInteraction.run(session.id, 'user', sent, null, null, null);
    recordUserMessage(session.id, sent); // Chat-view conversation log

    const result = await executeCommand(session, sent);
    const summary = summarizeForSpeech(result.text);

    // Synthesize spoken summary with whichever provider is active (best-effort; a
    // TTS failure must not fail the command — the text response is still returned).
    let audioPath = null;
    let ttsChars = null;
    if (summary && ttsConfigured()) {
      const t0 = Date.now();
      try {
        const audio = await synthesize(summary);
        audioPath = audio.path;
        ttsChars = audio.chars;
        log.info(`TTS ${audio.provider}/${audio.voiceId}: ${audio.chars} chars in ${Date.now() - t0}ms`);
      } catch (err) {
        log.warn(`TTS failed: ${err.message}`);
      }
    }

    const claudeRow = insertInteraction.run(session.id, 'claude', result.text, summary, audioPath, ttsChars);
    const interactionId = Number(claudeRow.lastInsertRowid);

    // Local speaker playback per configured target (fire-and-forget).
    const target = getConfig('tts_playback_target', 'desktop');
    if (audioPath && (target === 'desktop' || target === 'both')) {
      playLocal(audioPath).catch(() => {});
    }

    const audioUrl = audioPath ? `/api/tts/${interactionId}` : null;
    broadcastResponse({ sessionId: session.id, interactionId, summary, audioUrl });

    res.json({
      transcript: sent, // what was sent to Claude
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
