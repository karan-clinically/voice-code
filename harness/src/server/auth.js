// Auth for /api/* routes. Four trust tiers:
//   1. True localhost (the desktop app, the Stop hook) — a loopback socket with
//      NO proxy headers — is trusted unconditionally.
//   2. Tailnet peers arriving through `tailscale serve` — the local tailscaled
//      proxies them in from 127.0.0.1 WITH X-Forwarded-For plus Tailscale
//      identity headers (set/stripped by tailscaled itself, unforgeable from
//      outside) — are trusted like before, so the phone-on-tailnet needs no token.
//   3. Cloudflare Access users arriving through the local cloudflared tunnel —
//      identified by a SIGNED JWT (Cf-Access-Jwt-Assertion) that Cloudflare's
//      edge mints only after the user passed the Access login. Verified against
//      the team's public JWKS + the app's audience tag; active only when both
//      cf_access_* config keys are set.
//   4. Everything else — including PUBLIC INTERNET requests via `tailscale
//      funnel`, which arrive proxied but with the identity headers stripped —
//      must present the pairing token (Bearer header or ?token=).
// The proxy-header distinction is what keeps funnel/cloudflared from inheriting
// the localhost bypass: both proxies connect from 127.0.0.1, so a bare loopback
// check would expose the whole harness with no auth at all. Token comparison is
// timing-safe.

import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('auth');
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function loopbackSocket(req) {
  const ip = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_IPS.has(ip);
}

// True localhost: a direct loopback connection, not something proxied in by
// tailscale serve/funnel (always adds X-Forwarded-For) or cloudflared (always
// adds Cf-Connecting-Ip). Checking both headers means tunnel traffic can never
// inherit the localhost bypass even if one proxy changes its header behavior.
export function isLocalhost(req) {
  return loopbackSocket(req) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
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

// --- Cloudflare Access (the code.cnly.au front door) ---
// Cloudflare's edge authenticates the user (email one-time code) BEFORE the
// request reaches the tunnel, then attaches a short-lived RS256 JWT. We verify
// it against the team's published JWKS and the Access application's audience
// tag, so the harness never trusts tunnel traffic on the proxy's word alone.
// Inactive (always false) until cf_access_team_domain + cf_access_aud are set.
let jwksCache = null;
let jwksTeam = '';

function accessJwt(req) {
  const header = req.headers?.['cf-access-jwt-assertion'];
  if (header) return String(header);
  // WS upgrades / <audio src> can't set headers, but the browser sends the
  // Access cookie with every request to the protected hostname.
  const cookies = req.headers?.cookie || '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookies);
  return m ? m[1] : null;
}

export async function isCfAccessUser(req) {
  const team = String(getConfig('cf_access_team_domain', '') || '').trim(); // e.g. myteam.cloudflareaccess.com
  const aud = String(getConfig('cf_access_aud', '') || '').trim();
  if (!team || !aud) return false;
  const jwt = accessJwt(req);
  if (!jwt) return false;
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    if (!jwksCache || jwksTeam !== team) {
      jwksCache = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      jwksTeam = team;
    }
    await jwtVerify(jwt, jwksCache, { audience: aud, issuer: `https://${team}` });
    return true;
  } catch (err) {
    log.debug(`access jwt rejected: ${err.message}`);
    return false;
  }
}

// All four tiers in order. Shared by the HTTP middleware and the WS upgrade.
export async function authorizeRequest(req) {
  return isLocalhost(req) || isTailnetPeer(req) || hasValidToken(req) || (await isCfAccessUser(req));
}

export async function authMiddleware(req, res, next) {
  if (await authorizeRequest(req)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Reject anything not from true localhost, regardless of token (for the Stop
// hook). Proxied requests — tailnet or funnel — never pass.
export function localhostOnly(req, res, next) {
  if (isLocalhost(req)) return next();
  return res.status(403).json({ error: 'localhost only' });
}
