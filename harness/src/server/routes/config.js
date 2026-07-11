// Config read/write for the wizard. Localhost-only (touches secrets). GET
// /state returns non-secret status flags for routing + prefilling; POST saves
// an allowlisted set of keys.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { getConfig, setConfig, isFirstRun } from '../../config.js';

const router = Router();
router.use(localhostOnly);

const ALLOWED = new Set([
  'deepgram_api_key',
  'openai_api_key',
  'elevenlabs_api_key',
  'elevenlabs_voice_id',
  'tunnel_provider',
  'tunnel_url',
  'tts_playback_target',
  'device_name',
  'stt_mode',
  'stt_model',
  'tts_model',
  'dictation_cleanup',
  'cleanup_model',
  'mobile_base_dir',
  'apk_url',
]);

router.get('/state', (req, res) => {
  res.json({
    firstRun: isFirstRun(),
    hasDeepgram: !!getConfig('deepgram_api_key'),
    hasOpenAI: !!getConfig('openai_api_key'),
    hasElevenLabs: !!getConfig('elevenlabs_api_key'),
    sttMode: getConfig('stt_mode', 'batch'),
    voiceId: getConfig('elevenlabs_voice_id') || null,
    tunnelProvider: getConfig('tunnel_provider') || 'lan',
    tunnelUrl: getConfig('tunnel_url') || null,
    playbackTarget: getConfig('tts_playback_target') || 'desktop',
    hasToken: !!getConfig('pairing_token'),
    deviceName: getConfig('device_name') || null,
  });
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const saved = [];
  for (const key of Object.keys(body)) {
    if (ALLOWED.has(key) && body[key] != null && body[key] !== '') {
      setConfig(key, body[key]);
      saved.push(key);
    }
  }
  res.json({ ok: true, saved });
});

export default router;
