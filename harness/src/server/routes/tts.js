// GET  /api/tts/:interactionId — the spoken reply for an interaction.
//        First listener: synthesis is kicked off and the mp3 frames are streamed
//        as they arrive (audio starts in ~300ms rather than after the ~2s full
//        render). Replays: a plain file send from the audio cache.
// GET|POST /api/tts/say — speak arbitrary text, streamed the same way. GET exists
//        because an <audio src=…> element can only issue a GET, and letting the
//        element fetch the URL directly is what makes playback progressive —
//        buffering the response into a Blob first would throw the streaming away.
// Everything here goes through the speech cache: the first render streams, and
// anything already spoken is replayed from disk rather than summarized and
// synthesized again (same wording, no further spend).

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Router } from 'express';
import { streamAudio, streamSpeech, speechKey } from '../../services/ttsCache.js';
import { getMessages } from '../../services/conversation.js';
import { summarizeForSpeech, toPlainSpeech } from '../../services/summarize.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('tts');
const router = Router();
const MAX_SAY = 2000;
// A full reply is read verbatim, so it can be long — but not unbounded, or one
// runaway answer could bill a fortune in TTS characters.
const MAX_FULL = 12000;

// The audio type is the provider's, not an assumption: ElevenLabs and Deepgram
// speak mp3, Speechmatics speaks wav. A file is typed by its extension, a live
// stream by the mime its provider declared.
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/L16', ogg: 'audio/ogg' };
const mimeForFile = (path) => AUDIO_MIME[String(path).split('.').pop()?.toLowerCase()] || 'audio/mpeg';

// Pipe a web ReadableStream of audio out to the client, chunk by chunk.
function pipeAudio(res, stream, mime = 'audio/mpeg') {
  res.type(mime);
  res.setHeader('Cache-Control', 'no-store');
  Readable.fromWeb(stream).pipe(res);
}

// Send whichever the speech cache handed back: a finished file for something we
// have already spoken, or the live stream of a first render.
function sendSpeech(res, out) {
  if (out.path) {
    if (!existsSync(out.path)) return res.status(404).json({ error: 'audio not found' });
    res.type(mimeForFile(out.path));
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(out.path);
  }
  return pipeAudio(res, out.stream, out.mime);
}

async function say(req, res) {
  try {
    const text = String(req.method === 'GET' ? req.query.text || '' : req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > MAX_SAY) return res.status(413).json({ error: 'text too long' });
    const voiceId = req.method === 'GET' ? req.query.voiceId : req.body?.voiceId;
    // Spoken prompts and permission questions repeat verbatim — a re-render bills
    // for a clip we already have on disk.
    const out = await streamSpeech(speechKey('say', voiceId || '', text), () => text, {
      voiceId: voiceId || undefined,
    });
    sendSpeech(res, out);
  } catch (err) {
    log.warn(`say failed: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
}

router.get('/say', say);
router.post('/say', say);

// GET /api/tts/reply/:sessionId?mode=summary|full — speak this session's latest
// Claude reply. `summary` (default) is the short spoken version you get by
// default; `full` reads the whole answer verbatim.
//
// Keyed by session rather than taking the text as a query param, because the
// callers only hold the raw markdown: shipping it up the URL hit /say's 2000-char
// cap (so replaying a long reply just 413'd) and fed markdown symbols to the
// voice. Here the harness owns the text, strips the markdown, and streams.
// The newest assistant reply and how it will be spoken. Shared by the request
// that plays it and the prewarm below, so both resolve to the SAME cache key —
// re-summarising would word it differently and render (and bill) twice.
function replySpeech(sessionId, full) {
  const last = [...getMessages(sessionId)].reverse().find((m) => m.role === 'assistant');
  if (!last?.text) return null;
  return {
    key: speechKey('reply', full ? 'full' : 'summary', last.text),
    makeText: async () => {
      let text = full ? toPlainSpeech(last.text) : await summarizeForSpeech(last.text);
      if (full && text.length > MAX_FULL) text = `${text.slice(0, MAX_FULL)}… that is as much as I can read out.`;
      log.info(`speaking ${full ? 'full' : 'summary'} reply for session ${sessionId} (${text.length} chars)`);
      return text;
    },
  };
}

// Render the newest reply into the speech cache WITHOUT sending it, so tapping
// the speaker plays from disk instead of waiting on a render. The phone fires
// this for the session it is showing when a turn lands and it is not going to
// auto-play — one reply, one session, only where you might actually press play.
// Returns immediately: the render continues in the background.
router.post('/reply/:sessionId/prewarm', async (req, res) => {
  const sessionId = Number(req.params.sessionId);
  const speech = replySpeech(sessionId, req.query.mode === 'full');
  if (!speech) return res.status(404).json({ error: 'no reply to speak yet' });
  try {
    // streamSpeech already answers "is it cached?" — a hit returns a path and
    // renders nothing, so this needs no separate lookup.
    const out = await streamSpeech(speech.key, speech.makeText);
    if (out.path) return res.json({ cached: true });
    if (out.empty) return res.json({ warming: false });
    // A miss hands back a live stream. Let go of this branch — the cache copy is
    // the other half of a tee and completes on its own — and report the outcome
    // to the log rather than the caller: a failed prewarm must never surface as
    // a failed turn.
    out.stream?.cancel?.().catch(() => {});
    out.done?.catch((err) => log.warn(`prewarm render failed for session ${sessionId}: ${err.message}`));
    res.json({ warming: true });
  } catch (err) {
    log.warn(`prewarm failed for session ${sessionId}: ${err.message}`);
    res.json({ warming: false });
  }
});

router.get('/reply/:sessionId', async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const full = req.query.mode === 'full';
    const speech = replySpeech(sessionId, full);
    if (!speech) return res.status(404).json({ error: 'no reply to speak yet' });

    // Keyed on the reply text, so tapping 🔊 again on a reply you have already
    // heard replays that exact recording: no second summary (which would also come
    // back worded differently), no second synthesis, nothing billed.
    const out = await streamSpeech(speech.key, speech.makeText);
    if (out.empty) return res.status(404).json({ error: 'nothing to speak' });
    sendSpeech(res, out);
  } catch (err) {
    log.warn(`reply speech failed: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

router.get('/:interactionId', async (req, res) => {
  const id = Number(req.params.interactionId);
  try {
    const out = await streamAudio(id);
    if (out.missing || out.empty) return res.status(404).json({ error: 'audio not found' });
    if (out.path) {
      if (!existsSync(out.path)) return res.status(404).json({ error: 'audio not found' });
      res.type(mimeForFile(out.path));
      return res.sendFile(out.path);
    }
    pipeAudio(res, out.stream, out.mime);
  } catch (err) {
    log.warn(`tts for interaction ${id} failed: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

export default router;
