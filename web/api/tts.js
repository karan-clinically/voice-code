// GET /api/tts?text=…&token=… — Deepgram Aura-2 text-to-speech, streamed as
// mp3. A GET with ?token= (not a header) so a plain <audio src> can play it.
// Chunks are forwarded as they arrive — Aura-2's ~300ms first byte is what
// makes spoken replies feel immediate; buffering the render would waste that.

import { requireAuth, deepgramKey, json } from './_lib/util.js';

const MAX_CHARS = 1900; // Deepgram /v1/speak caps input around 2000 chars
const DEFAULT_VOICE = 'aura-2-thalia-en';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const text = String(req.query.text || '').slice(0, MAX_CHARS).trim();
  if (!text) {
    json(res, 400, { error: 'text required' });
    return;
  }
  const voice = /^aura-2-[a-z]+-[a-z]{2}$/.test(String(req.query.voice || ''))
    ? req.query.voice
    : DEFAULT_VOICE;

  const r = await fetch(
    `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${deepgramKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }
  );
  if (!r.ok || !r.body) {
    const detail = await r.text().catch(() => '');
    json(res, 502, { error: `TTS failed (${r.status}): ${detail.slice(0, 300)}` });
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('cache-control', 'no-store');
  for await (const chunk of r.body) {
    res.write(chunk);
  }
  res.end();
}
