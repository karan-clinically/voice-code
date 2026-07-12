// ElevenLabs text-to-speech. Endpoint verified against current docs (July 2026):
// POST /v1/text-to-speech/{voice_id}, header xi-api-key, body {text, model_id},
// output_format query param. Default model eleven_turbo_v2_5 (low latency, good
// quality); eleven_flash_v2_5 is the faster/cheaper alternative — override with
// the `tts_model` config key. Uses native fetch (no HTTP client dependency).
//
// Behaviour is unchanged from the pre-provider-split version; it now just
// conforms to the shared provider contract (see ../index.js).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIO_DIR } from '../../../db.js';
import { getConfig } from '../../../config.js';
import { recordUsage } from '../../usage.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('tts:elevenlabs');
const BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL = 'eleven_turbo_v2_5';
const DEFAULT_FORMAT = 'mp3_44100_128';

export const label = 'ElevenLabs';

export function isConfigured() {
  return !!getConfig('elevenlabs_api_key');
}

export function getVoiceId() {
  return getConfig('elevenlabs_voice_id') || null;
}

export async function synthesize(text, { voiceId, modelId, outputFormat } = {}) {
  const apiKey = getConfig('elevenlabs_api_key');
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  const voice = voiceId || getVoiceId();
  if (!voice) throw new Error('no ElevenLabs voice selected');
  if (!text || !text.trim()) throw new Error('empty text');

  const model = modelId || getConfig('tts_model', DEFAULT_MODEL);
  const format = outputFormat || DEFAULT_FORMAT;
  const url = `${BASE}/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }),
    });
  } catch (err) {
    log.error(`TTS request failed: ${err.message}`);
    throw new Error(`TTS request failed: ${err.message}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    log.error(`TTS HTTP ${resp.status}: ${body.slice(0, 300)}`);
    throw new Error(`TTS failed (HTTP ${resp.status})`);
  }

  const id = randomUUID();
  const filename = `${id}.mp3`;
  const path = join(AUDIO_DIR, filename);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(path, buf);
  log.info(`synthesized ${text.length} chars via ${model} -> ${filename} (${buf.length}B)`);
  recordUsage('elevenlabs', 'tts', 'elevenlabs_tts_char', text.length);
  return { id, path, filename, voiceId: voice, chars: text.length };
}

// Progressive synthesis via the /stream endpoint, so playback can start on the
// first mp3 frames instead of waiting for the full render.
export async function synthesizeStream(text, { voiceId, modelId, outputFormat } = {}) {
  const apiKey = getConfig('elevenlabs_api_key');
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  const voice = voiceId || getVoiceId();
  if (!voice) throw new Error('no ElevenLabs voice selected');
  if (!text || !text.trim()) throw new Error('empty text');

  const model = modelId || getConfig('tts_model', DEFAULT_MODEL);
  const format = outputFormat || DEFAULT_FORMAT;
  const url = `${BASE}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${format}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    log.error(`TTS stream HTTP ${resp.status}: ${body.slice(0, 200)}`);
    throw new Error(`TTS failed (HTTP ${resp.status})`);
  }
  recordUsage('elevenlabs', 'tts', 'elevenlabs_tts_char', text.length);
  return { stream: resp.body, voiceId: voice };
}

// List available voices for the voice picker (wizard).
export async function listVoices() {
  const apiKey = getConfig('elevenlabs_api_key');
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  const resp = await fetch(`${BASE}/voices`, { headers: { 'xi-api-key': apiKey } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`list voices failed (HTTP ${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
    preview_url: v.preview_url,
  }));
}
