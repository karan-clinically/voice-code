// GET /api/tunnel/tailscale — detect Tailscale + derive the harness base URL.
// Localhost-only.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { getConfig } from '../../config.js';
import { detectTailscale } from '../../services/tunnel.js';

const router = Router();
router.use(localhostOnly);

router.get('/tailscale', async (req, res) => {
  res.json(await detectTailscale(Number(getConfig('port', 4620))));
});

export default router;
