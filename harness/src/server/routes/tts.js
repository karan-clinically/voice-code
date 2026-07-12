// GET  /api/tts/:interactionId — the spoken reply for an interaction.
//        First listener: synthesis is kicked off and the mp3 frames are streamed
//        as they arrive (audio starts in ~300ms rather than after the ~2s full
//        render). Replays: a plain file send from the audio cache.
// GET|POST /api/tts/say — speak arbitrary text, streamed the same way. GET exists
//        because an <audio src=…> element can only issue a GET, and letting the
//        element fetch the URL directly is what makes playback progressive —
//        buffering the response into a Blob first would throw the streaming away.

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Router } from 'express';
import { synthesizeStream } from '../../services/tts/index.js';
import { streamAudio } from '../../services/ttsCache.js';
import { getMessages } from '../../services/conversation.js';
import { summarizeForSpeech, toPlainSpeech } from '../../services/summarize.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('tts');
const router = Router();
const MAX_SAY = 2000;
// A full reply is read verbatim, so it can be long — but not unbounded, or one
// runaway answer could bill a fortune in TTS characters.
const MAX_FULL = 12000;

// Pipe a web ReadableStream of mp3 out to the client, chunk by chunk.
function pipeAudio(res, stream) {
  res.type('audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  Readable.fromWeb(stream).pipe(res);
}

async function say(req, res) {
  try {
    const text = String(req.method === 'GET' ? req.query.text || '' : req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > MAX_SAY) return res.status(413).json({ error: 'text too long' });
    const voiceId = req.method === 'GET' ? req.query.voiceId : req.body?.voiceId;
    const { stream } = await synthesizeStream(text, { voiceId: voiceId || undefined });
    pipeAudio(res, stream);
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
router.get('/reply/:sessionId', async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const full = req.query.mode === 'full';
    const last = [...getMessages(sessionId)].reverse().find((m) => m.role === 'assistant');
    if (!last?.text) return res.status(404).json({ error: 'no reply to speak yet' });

    let text = full ? toPlainSpeech(last.text) : await summarizeForSpeech(last.text);
    if (!text) return res.status(404).json({ error: 'nothing to speak' });
    if (full && text.length > MAX_FULL) text = `${text.slice(0, MAX_FULL)}… that is as much as I can read out.`;

    log.info(`speaking ${full ? 'full' : 'summary'} reply for session ${sessionId} (${text.length} chars)`);
    const { stream } = await synthesizeStream(text);
    pipeAudio(res, stream);
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
      res.type('audio/mpeg');
      return res.sendFile(out.path);
    }
    pipeAudio(res, out.stream);
  } catch (err) {
    log.warn(`tts for interaction ${id} failed: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

export default router;
