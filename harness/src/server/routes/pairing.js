// Pairing payload for the QR code + token regeneration. Localhost-only.
// Payload shape matches plan §6.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { localhostOnly } from '../auth.js';
import { getConfig, setConfig } from '../../config.js';

const router = Router();
router.use(localhostOnly);

function ensureToken() {
  let t = getConfig('pairing_token');
  if (!t) {
    t = randomBytes(32).toString('hex');
    setConfig('pairing_token', t);
  }
  return t;
}

function baseUrl() {
  const url = getConfig('tunnel_url');
  if (url) return url;
  return `http://localhost:${getConfig('port', 4620)}`;
}

router.get('/payload', (req, res) => {
  res.json({
    v: 1,
    name: getConfig('device_name') || hostname(),
    baseUrl: baseUrl(),
    token: ensureToken(),
    apk: getConfig('apk_url') || '',
  });
});

router.post('/regen', (req, res) => {
  const token = randomBytes(32).toString('hex');
  setConfig('pairing_token', token);
  res.json({ token });
});

export default router;
