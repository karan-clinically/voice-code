// GET /api/stt-token — mints a short-lived Deepgram JWT so the browser can
// stream mic audio directly to wss://api.deepgram.com/v1/listen without the
// long-lived API key ever reaching the client. (Vercel functions can't host
// the WebSocket relay the old harness used, so the browser goes direct.)

import { requireAuth, json, fail, deepgramKey } from './_lib/util.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${deepgramKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 300 }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw Object.assign(new Error(`Deepgram grant failed (${r.status}): ${text.slice(0, 300)}`), {
        status: 502,
      });
    }
    const grant = await r.json();
    json(res, 200, { access_token: grant.access_token, expires_in: grant.expires_in });
  } catch (err) {
    fail(res, err);
  }
}
