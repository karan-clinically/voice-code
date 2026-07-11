// Auth for /api/* routes: allow localhost (the desktop app) unconditionally,
// otherwise require Authorization: Bearer <pairing_token>. Token comparison is
// timing-safe. hooks routes get their own localhost-only guard (step 7).

import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalhost(req) {
  const ip = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_IPS.has(ip);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function authMiddleware(req, res, next) {
  if (isLocalhost(req)) return next();
  const token = getConfig('pairing_token');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const bearer = m ? m[1] : null;
  // Also accept ?token= for GET media/WS where headers can't be set (e.g. <audio src>).
  const query = typeof req.query.token === 'string' ? req.query.token : null;
  if ((bearer && safeEqual(bearer, token)) || (query && safeEqual(query, token))) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Reject anything not from localhost, regardless of token (for the Stop hook).
export function localhostOnly(req, res, next) {
  if (isLocalhost(req)) return next();
  return res.status(403).json({ error: 'localhost only' });
}
