// Settings reachable from the phone/PWA (standard auth).
//   GET  /api/settings        -> safe prefs + non-secret availability flags
//   POST /api/settings {..}   -> writes ONLY the non-secret allowlisted keys
//   GET  /api/settings/keys   -> non-secret API-key presence flags
//   POST /api/settings/keys   -> writes ONLY allowlisted API keys; never returns values
//
// /api/config remains localhost-only for the desktop wizard. This route exposes a
// narrower phone-safe settings surface: normal prefs plus a dedicated key-writer
// endpoint that accepts secret values but returns only has-key flags. API key
// values are never readable through the PWA.
//
// /api/stt/mode was the earlier, narrower version of this; it is now folded in.

import { Router } from 'express';
import { getConfig, setConfig } from '../../config.js';
import { listVoices } from '../../services/tts/index.js';

const router = Router();

// key -> validator. Nothing outside this map can be written by /api/settings.
const ALLOWED = {
  stt_mode: (v) => ['batch', 'stream'].includes(v),
  dictation_summarise: (v) => ['on', 'off'].includes(v),
  stt_provider: (v) => ['elevenlabs', 'deepgram'].includes(v),
  tts_provider: (v) => ['elevenlabs', 'deepgram'].includes(v),
  elevenlabs_voice_id: (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v),
  deepgram_tts_voice: (v) => typeof v === 'string' && /^aura-2-[\w-]{1,48}$/.test(v),
};

// API-key writer allowlist. Values are accepted, stored server-side, and never
// returned. Blank strings are ignored ("blank keeps existing").
const KEY_ALLOWED = {
  xai_api_key: (v) => typeof v === 'string' && /^xai-[A-Za-z0-9_-]{12,}$/.test(v.trim()),
  elevenlabs_api_key: (v) => typeof v === 'string' && v.trim().length >= 20,
  deepgram_api_key: (v) => typeof v === 'string' && v.trim().length >= 20,
  openai_api_key: (v) => typeof v === 'string' && /^sk-[A-Za-z0-9_-]{12,}$/.test(v.trim()),
};

function readKeyState() {
  return {
    hasXai: !!getConfig('xai_api_key'),
    hasElevenLabs: !!getConfig('elevenlabs_api_key'),
    hasDeepgram: !!getConfig('deepgram_api_key'),
    hasOpenAI: !!getConfig('openai_api_key'),
  };
}

function readSettings() {
  return {
    stt_mode: getConfig('stt_mode', 'batch'),
    dictation_summarise: getConfig('dictation_summarise', 'off'),
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
router.get('/keys', (req, res) => res.json(readKeyState()));

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

router.post('/keys', (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: 'no API keys provided' });

  const saved = [];
  for (const k of keys) {
    if (!Object.hasOwn(KEY_ALLOWED, k)) {
      return res.status(400).json({ error: `"${k}" is not a settable API key` });
    }
    const v = typeof body[k] === 'string' ? body[k].trim() : body[k];
    if (v == null || v === '') continue;
    if (!KEY_ALLOWED[k](v)) {
      return res.status(400).json({ error: `invalid value for "${k}"` });
    }
    setConfig(k, v);
    saved.push(k);
  }
  res.json({ ok: true, saved, ...readKeyState() });
});

export default router;
