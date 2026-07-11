// Dictation mode, shared by every client.
//   GET  /api/stt/mode        -> { mode: 'batch' | 'stream' }
//   POST /api/stt/mode {mode} -> { mode }
// This lives outside /api/config because that router is localhost-only (it holds
// secrets) and the phone needs to read/flip the mode too. The value is non-secret
// and persists in SQLite, so the toggle survives restarts on both devices.

import { Router } from 'express';
import { getConfig, setConfig } from '../../config.js';

const MODES = new Set(['batch', 'stream']);
const router = Router();

router.get('/mode', (req, res) => {
  res.json({ mode: getConfig('stt_mode', 'batch') });
});

router.post('/mode', (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be "batch" or "stream"' });
  setConfig('stt_mode', mode);
  res.json({ mode });
});

export default router;
