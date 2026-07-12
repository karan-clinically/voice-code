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
import { executeCommand } from '../../services/claudeCode.js';
import { summarizeForSpeech } from '../../services/summarize.js';
import { recordUserMessage } from '../../services/conversation.js';
import { isConfigured as ttsConfigured } from '../../services/tts/index.js';
import { ensureAudio } from '../../services/ttsCache.js';
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

    // Hands-free voice passes a short timeout so a turn that never signals
    // completion fails fast and the loop recovers, instead of the caller waiting
    // out the 10-minute default in dead silence. Clamped to a sane range.
    const raw = Number(req.body.timeoutMs);
    const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(raw, 10_000), 10 * 60_000) : undefined;

    const result = await executeCommand(session, sent, timeoutMs ? { timeoutMs } : undefined);
    const summary = await summarizeForSpeech(result.text);

    // The reply is recorded with no audio yet. Synthesis is the slowest step in a
    // turn (~2s for a full render), so we do NOT block the response on it: the
    // client is handed /api/tts/<id> straight away and the first listener gets the
    // mp3 streamed as it renders (~300ms to first sound). See services/ttsCache.js.
    const claudeRow = insertInteraction.run(session.id, 'claude', result.text, summary, null, null);
    const interactionId = Number(claudeRow.lastInsertRowid);

    const speakable = !!summary && ttsConfigured();
    const audioUrl = speakable ? `/api/tts/${interactionId}` : null;
    broadcastResponse({ sessionId: session.id, interactionId, summary, audioUrl });

    // The local PowerShell player needs a finished file, not a pipe — render in
    // the background (deduped with any listener's request) and play when ready.
    const target = getConfig('tts_playback_target', 'desktop');
    if (speakable && (target === 'desktop' || target === 'both')) {
      ensureAudio(interactionId)
        .then((a) => a.path && playLocal(a.path))
        .catch((err) => log.warn(`local playback failed: ${err.message}`));
    }

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
