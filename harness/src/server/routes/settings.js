// Non-secret preferences, reachable from the phone (standard auth).
//   GET  /api/settings        -> the safe prefs below
//   POST /api/settings {..}   -> writes ONLY the allowlisted keys
//
// This exists because /api/config is localhost-only: it reads and writes API
// keys, so the phone must never reach it. Everything here is non-secret by
// construction — the allowlist is a strict whitelist, and any other key (above
// all *_api_key) is rejected rather than ignored, so a typo can't silently
// become a write. API keys can be neither read nor written through this route.
//
// /api/stt/mode was the earlier, narrower version of this; it is now folded in.

import { Router } from 'express';
import { getConfig, setConfig } from '../../config.js';
import { listVoices } from '../../services/tts/index.js';

const router = Router();

// key -> validator. Nothing outside this map can be written.
const ALLOWED = {
  stt_mode: (v) => ['batch', 'stream'].includes(v),
  stt_provider: (v) => ['elevenlabs', 'deepgram'].includes(v),
  tts_provider: (v) => ['elevenlabs', 'deepgram'].includes(v),
  elevenlabs_voice_id: (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v),
  deepgram_tts_voice: (v) => typeof v === 'string' && /^aura-2-[\w-]{1,48}$/.test(v),
};

function readSettings() {
  return {
    stt_mode: getConfig('stt_mode', 'batch'),
    stt_provider: getConfig('stt_provider') || null,
    tts_provider: getConfig('tts_provider') || null,
    elevenlabs_voice_id: getConfig('elevenlabs_voice_id') || null,
    deepgram_tts_voice: getConfig('deepgram_tts_voice') || null,
    // Booleans only — whether a key exists, never the key itself. The phone needs
    // this to know which provider tabs it may offer.
    elevenlabs_available: !!getConfig('elevenlabs_api_key'),
    deepgram_available: !!getConfig('deepgram_api_key'),
  };
}

router.get('/', (req, res) => res.json(readSettings()));

// Phone-safe ElevenLabs voice list for the Settings voice picker. Returns only
// non-secret voice metadata (id/name/category) — the API key stays server-side,
// unlike the localhost-only /api/voices route.
router.get('/voices', async (req, res) => {
  try {
    res.json({ voices: await listVoices('elevenlabs') });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: 'no settings provided' });

  for (const k of keys) {
    if (!Object.hasOwn(ALLOWED, k)) {
      return res.status(400).json({ error: `"${k}" is not a settable setting` });
    }
    if (!ALLOWED[k](body[k])) {
      return res.status(400).json({ error: `invalid value for "${k}"` });
    }
  }
  for (const k of keys) setConfig(k, body[k]);
  res.json(readSettings());
});

export default router;
