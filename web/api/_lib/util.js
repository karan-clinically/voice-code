// Shared helpers for the Vercel serverless API.
//
// Auth here is deliberately simple: this is a single-user deployment guarded by
// one shared secret (APP_ACCESS_TOKEN) that the phone stores after first entry.
// All provider keys (Anthropic, Deepgram) stay server-side in Vercel env vars —
// the browser only ever holds the app token and short-lived Deepgram JWTs.

import { timingSafeEqual } from 'node:crypto';

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const BETA = 'managed-agents-2026-04-01';

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function tokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  // <audio> elements and EventSource can't set headers, so allow ?token=
  const q = req.query?.token;
  return typeof q === 'string' ? q : null;
}

// Returns true if the request is authorized; otherwise writes the error
// response and returns false.
export function requireAuth(req, res) {
  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected) {
    json(res, 500, {
      error: 'APP_ACCESS_TOKEN is not set. Add it in Vercel → Project → Settings → Environment Variables.',
    });
    return false;
  }
  const got = tokenFromReq(req);
  if (got) {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  json(res, 401, { error: 'unauthorized' });
  return false;
}

export function anthropicHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': BETA,
    'content-type': 'application/json',
  };
}

// Thin fetch wrapper for the Managed Agents API. Throws an Error carrying the
// upstream status so route handlers can pass it through.
export async function anthropic(path, { method = 'GET', body, query } = {}) {
  const url = new URL(ANTHROPIC_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    method,
    headers: anthropicHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`Anthropic ${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`);
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return null;
  return r.json();
}

export function deepgramKey() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set');
  return key;
}

// Uniform error responder: keeps upstream status codes (401/404/429) visible to
// the client instead of flattening everything into a 500.
export function fail(res, err) {
  const status = Number.isInteger(err.status) ? err.status : 500;
  json(res, status, { error: err.message || 'internal error' });
}
