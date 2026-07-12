// Turn a completed turn (executeCommand / awaitReply result) into the client
// payload: record the interaction, summarize for speech, hand back a lazy TTS url,
// and kick off desktop playback. Shared by POST /api/command (text turns) and the
// picker-select route (answering an interactive prompt), so both paths speak and
// record identically.

import db from '../db.js';
import { getConfig } from '../config.js';
import { summarizeForSpeech } from './summarize.js';
import { isConfigured as ttsConfigured } from './tts/index.js';
import { ensureAudio } from './ttsCache.js';
import { playLocal } from './audio.js';
import { broadcastResponse } from '../server/ws.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('reply');

const insertInteraction = db.prepare(
  'INSERT INTO interactions (session_id, direction, text, summary, audio_path, tts_chars) VALUES (?, ?, ?, ?, ?, ?)'
);

export function recordUserInteraction(sessionId, text) {
  insertInteraction.run(sessionId, 'user', text, null, null, null);
}

// `desktopPlayback` (default true) renders the whole clip up front to play on the
// harness machine's speaker. Remote phone clients pass false: that render blocks
// the phone's /api/tts request (it waits for the full render instead of streaming),
// so skipping it lets Aura-2 stream to the phone and start ~0.4s in. The desktop
// app plays the audioUrl in its own <audio>, so it doesn't need this path.
export async function buildReplyResponse(session, result, { desktopPlayback = true } = {}) {
  const summary = await summarizeForSpeech(result.text);

  // Recorded with no audio yet — synthesis is the slowest step, so the client is
  // handed /api/tts/<id> immediately and the first listener streams the mp3.
  const claudeRow = insertInteraction.run(session.id, 'claude', result.text, summary, null, null);
  const interactionId = Number(claudeRow.lastInsertRowid);

  const speakable = !!summary && ttsConfigured();
  const audioUrl = speakable ? `/api/tts/${interactionId}` : null;
  broadcastResponse({ sessionId: session.id, interactionId, summary, audioUrl });

  const target = getConfig('tts_playback_target', 'desktop');
  if (speakable && desktopPlayback && (target === 'desktop' || target === 'both')) {
    ensureAudio(interactionId)
      .then((a) => a.path && playLocal(a.path))
      .catch((err) => log.warn(`local playback failed: ${err.message}`));
  }

  return {
    responseText: result.text,
    summary,
    audioUrl,
    interactionId,
    via: result.via,
    stopReason: result.stopReason,
    prompt: result.prompt || null,
  };
}
