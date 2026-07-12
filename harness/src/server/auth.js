// Auth for /api/* routes. Three trust tiers:
//   1. True localhost (the desktop app, the Stop hook) — a loopback socket with
//      NO X-Forwarded-For header — is trusted unconditionally.
//   2. Tailnet peers arriving through `tailscale serve` — the local tailscaled
//      proxies them in from 127.0.0.1 WITH X-Forwarded-For plus Tailscale
//      identity headers (set/stripped by tailscaled itself, unforgeable from
//      outside) — are trusted like before, so the phone-on-tailnet needs no token.
//   3. Everything else — including PUBLIC INTERNET requests via `tailscale
//      funnel`, which arrive proxied but with the identity headers stripped —
//      must present the pairing token (Bearer header or ?token=).
// The X-Forwarded-For distinction is what keeps funnel from inheriting the
// localhost bypass: without it, funnel would expose the whole harness with no
// auth at all. Token comparison is timing-safe.

import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function loopbackSocket(req) {
  const ip = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_IPS.has(ip);
}

// True localhost: a direct loopback connection, not something proxied in by
// tailscale serve/funnel (those always add X-Forwarded-For).
export function isLocalhost(req) {
  return loopbackSocket(req) && !req.headers['x-forwarded-for'];
}

// A tailnet member proxied in by the local tailscaled: loopback socket, proxied,
// and carrying the Tailscale identity header. tailscaled strips this header from
// funnel (public) requests, so it can't be spoofed from the internet; a non-
// loopback client can't use it either (nothing but the local proxy is trusted).
export function isTailnetPeer(req) {
  return loopbackSocket(req) && !!req.headers['x-forwarded-for'] && !!req.headers['tailscale-user-login'];
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hasValidToken(req) {
  const token = getConfig('pairing_token');
  if (!token) return false;
  const header = req.get ? req.get('authorization') || '' : req.headers?.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1], token)) return true;
  // Also accept ?token= for GET media/WS where headers can't be set (e.g. <audio src>).
  let q = null;
  if (req.query && typeof req.query.token === 'string') q = req.query.token;
  else {
    try {
      q = new URL(req.url, 'http://localhost').searchParams.get('token');
    } catch {
      q = null;
    }
  }
  return !!(q && safeEqual(q, token));
}

export function authMiddleware(req, res, next) {
  if (isLocalhost(req) || isTailnetPeer(req) || hasValidToken(req)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Reject anything not from true localhost, regardless of token (for the Stop
// hook). Proxied requests — tailnet or funnel — never pass.
export function localhostOnly(req, res, next) {
  if (isLocalhost(req)) return next();
  return res.status(403).json({ error: 'localhost only' });
}
