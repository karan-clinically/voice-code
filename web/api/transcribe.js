// POST /api/transcribe — batch speech-to-text fallback path.
//
// The primary dictation path streams mic audio from the browser straight to
// Deepgram with a short-lived token (see /api/stt-token). This route covers
// browsers/networks where that WebSocket fails: the client records the whole
// utterance (MediaRecorder webm/opus, or mp4 on iOS) and posts the blob here.
// The body must be application/octet-stream so Vercel's helper hands us a raw
// Buffer; the real audio mime travels in x-audio-type for Deepgram to use.
// Vercel caps request bodies at ~4.5 MB — several minutes of opus, plenty for
// a dictated prompt.

import { requireAuth, json, fail, deepgramKey } from './_lib/util.js';

const DG_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }
  try {
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      json(res, 400, { error: 'empty audio body (send Content-Type: application/octet-stream)' });
      return;
    }
    const mime = req.headers['x-audio-type'] || 'audio/webm';
    const r = await fetch(DG_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${deepgramKey()}`, 'content-type': mime },
      body: audio,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw Object.assign(new Error(`Deepgram transcription failed (${r.status}): ${text.slice(0, 300)}`), {
        status: 502,
      });
    }
    const result = await r.json();
    const transcript = (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
    json(res, 200, { text: transcript });
  } catch (err) {
    fail(res, err);
  }
}
