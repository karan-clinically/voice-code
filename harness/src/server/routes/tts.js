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
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('tts');
const router = Router();
const MAX_SAY = 2000;

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
