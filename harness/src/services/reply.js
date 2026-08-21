// Turn a completed turn (executeCommand / awaitReply result) into the client
// payload: record the interaction, summarize for speech, hand back a lazy TTS url,
// and kick off desktop playback. Shared by POST /api/command (text turns) and the
// picker-select route (answering an interactive prompt), so both paths speak and
// record identically.

import db from '../db.js';
import { getConfig } from '../config.js';
import { summarizeForSpeech, summarizeFindingsForSpeech } from './summarize.js';
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

const selLatestReply = db.prepare(`
  SELECT id AS interactionId, summary, created_at AS at
  FROM interactions
  WHERE session_id = ? AND direction = 'claude' AND summary IS NOT NULL AND summary <> ''
  ORDER BY id DESC LIMIT 1
`);

const selRepliesAfter = db.prepare(`
  SELECT id AS interactionId, summary, created_at AS at
  FROM interactions
  WHERE session_id = ? AND direction = 'claude' AND summary IS NOT NULL AND summary <> '' AND id > ?
  ORDER BY id DESC LIMIT ?
`);

const withUrl = (row) => ({ ...row, audioUrl: `/api/tts/${row.interactionId}` });

// The newest reply this session can speak, for clients that poll rather than hold
// the command response — a turn is only speakable if it was given a summary, so
// summary-less rows are skipped instead of being offered with nothing to play.
export function latestSpokenReply(sessionId) {
  if (!ttsConfigured()) return null;
  const row = selLatestReply.get(Number(sessionId));
  return row ? withUrl(row) : null;
}

// Every reply since the one a client last heard, oldest first, so a poll that lands
// after several agents reported can play them all in order rather than only the
// last. Capped: falling far behind (a phone asleep through a long session) should
// not turn one poll into ten minutes of catch-up audio.
export function spokenRepliesAfter(sessionId, afterId, limit = 5) {
  if (!ttsConfigured()) return [];
  const rows = selRepliesAfter.all(Number(sessionId), Number(afterId) || 0, limit);
  return rows.reverse().map(withUrl);
}

// How a finished turn should be said.
//
// A turn that ended on a question is the interesting case: the picker holds only
// the question, so speaking it alone ("Claude is asking: should I use A or B?")
// hands you a decision with none of the work behind it — useless when you can't
// look at the screen. So the findings are summarized first, in some detail, and
// the question is appended afterwards, verbatim, as the last thing you hear.
// A permission dialog stays a one-liner: its own intent, never the command.
export async function spokenReply(result) {
  const prompt = result.prompt;
  if (!prompt) return summarizeForSpeech(result.text);
  if (prompt.permission || !result.findings) return prompt.speech;
  const findings = await summarizeFindingsForSpeech(result.findings);
  return findings ? `${findings}\n\n${prompt.ask}` : prompt.speech;
}

// Record a finished assistant turn and announce it, handing back the lazy TTS url.
// Every completed turn goes through here — not just the ones a client asked for —
// so a turn that finished on its own (typed in the terminal, or an agent reporting
// back mid-session) is just as speakable as one the phone sent. Synthesis stays
// lazy: the row is written with audio_path NULL and nothing is billed unless
// somebody actually plays it.
export function publishTurn(sessionId, text, summary) {
  const row = insertInteraction.run(sessionId, 'claude', text, summary, null, null);
  const interactionId = Number(row.lastInsertRowid);
  const audioUrl = summary && ttsConfigured() ? `/api/tts/${interactionId}` : null;
  broadcastResponse({ sessionId, interactionId, summary, audioUrl });
  return { interactionId, audioUrl };
}

// `desktopPlayback` (default true) renders the whole clip up front to play on the
// harness machine's speaker. Remote phone clients pass false: that render blocks
// the phone's /api/tts request (it waits for the full render instead of streaming),
// so skipping it lets Aura-2 stream to the phone and start ~0.4s in. The desktop
// app plays the audioUrl in its own <audio>, so it doesn't need this path.
export async function buildReplyResponse(session, result, { desktopPlayback = true } = {}) {
  const summary = await spokenReply(result);

  // Recorded with no audio yet — synthesis is the slowest step, so the client is
  // handed /api/tts/<id> immediately and the first listener streams the mp3.
  const { interactionId, audioUrl } = publishTurn(session.id, result.text, summary);
  const speakable = !!audioUrl;

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
