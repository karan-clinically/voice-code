// Password login for the code.cnly.au front door. Mounted BEFORE the /api auth
// gate (an unauthenticated browser must be able to reach /login + these routes).
//
//   GET  /api/auth/status  — { passwordSet, authed }  (no secrets)
//   POST /api/auth/login   — { password } -> session cookie (7 days)
//   POST /api/auth/logout  — clears the cookie
//
// The password endpoint is publicly reachable through the tunnel, so the rate
// limiter runs before anything else: 8 failures per IP per 15 minutes, then a
// 15-minute lockout. State is in-memory — a harness restart resets it, which is
// acceptable for a single-owner box (and an attacker can't restart the harness).

import { Router } from 'express';
import {
  authorizeRequest, clearSessionCookie, issueSessionCookie, passwordConfigured, verifyWebPassword,
} from '../auth.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('auth-login');
const router = Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const failures = new Map(); // ip -> { count, windowStart }

function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function throttled(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) failures.set(ip, { count: 1, windowStart: now });
  else entry.count += 1;
  // Bounded: evict stale windows so the map can't grow unboundedly.
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (now - v.windowStart > WINDOW_MS) failures.delete(k);
  }
}

router.get('/status', async (req, res) => {
  res.json({ passwordSet: passwordConfigured(), authed: await authorizeRequest(req) });
});

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  if (throttled(ip)) {
    log.warn(`login throttled for ${ip}`);
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
  if (!passwordConfigured()) {
    return res.status(409).json({ error: 'no password is set — run set-password on the PC first' });
  }
  const ok = await verifyWebPassword(req.body?.password);
  if (!ok) {
    recordFailure(ip);
    log.warn(`failed login from ${ip}`);
    // Constant-ish response delay keeps timing from distinguishing "close" guesses.
    await new Promise((done) => setTimeout(done, 350));
    return res.status(401).json({ error: 'wrong password' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', issueSessionCookie());
  log.info(`web login from ${ip}`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

export default router;
