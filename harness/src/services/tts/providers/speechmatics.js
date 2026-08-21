// Speechmatics text-to-speech. Same contract as the other two providers, with one
// difference that reaches the rest of the pipeline: Speechmatics returns WAV or
// raw PCM — there is no mp3 option — so this provider declares `audioExt`/`mime`
// and the cache and the /api/tts routes carry the format through rather than
// assuming mp3 (see services/tts/index.js).
//
// The trade is deliberate: at $0.011 per 1k characters against ElevenLabs' $0.05
// (Flash) to $0.10 (Multilingual), and a free tier in the millions of characters,
// this is roughly an order of magnitude cheaper for a spoken summary. What you
// give up is choice — four English voices, no cloning, no other languages — and
// bytes: WAV at 16kHz/16-bit/mono is ~32KB per second of speech, several times an
// mp3 of the same reply, which matters on a phone over the funnel.
//
// The endpoint is Speechmatics' preview host; `tts_speechmatics_url` overrides it
// so a move to a stable host needs no code change.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIO_DIR } from '../../../db.js';
import { getConfig } from '../../../config.js';
import { recordUsage } from '../../usage.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('tts:speechmatics');
const DEFAULT_BASE = 'https://preview.tts.speechmatics.com';
const DEFAULT_VOICE = 'sarah';

export const label = 'Speechmatics';
// WAV, not mp3 — the pipeline reads these two to name and serve the audio.
export const audioExt = 'wav';
export const mime = 'audio/wav';

// English only today (their docs list exactly these four); no network call needed
// and no hand-maintained list beyond what the API actually offers.
const VOICES = [
  { voice_id: 'sarah', name: 'Sarah', category: 'English (UK)' },
  { voice_id: 'theo', name: 'Theo', category: 'English (UK)' },
  { voice_id: 'megan', name: 'Megan', category: 'English (US)' },
  { voice_id: 'jack', name: 'Jack', category: 'English (US)' },
];

export function isConfigured() {
  return !!getConfig('speechmatics_api_key');
}

export function getVoiceId() {
  return getConfig('speechmatics_voice_id') || DEFAULT_VOICE;
}

export async function listVoices() {
  return VOICES;
}

function endpoint(voice) {
  const base = String(getConfig('tts_speechmatics_url', DEFAULT_BASE)).replace(/\/+$/, '');
  return `${base}/generate/${encodeURIComponent(voice)}`;
}

async function request(text, voiceId) {
  const apiKey = getConfig('speechmatics_api_key');
  if (!apiKey) throw new Error('Speechmatics API key not configured');
  const voice = voiceId || getVoiceId();
  if (!text || !text.trim()) throw new Error('empty text');

  let resp;
  try {
    resp = await fetch(endpoint(voice), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    log.error(`TTS request failed: ${err.message}`);
    throw new Error(`TTS request failed: ${err.message}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    // Logged in full because the status alone never says WHY — an exhausted
    // quota and a revoked key both arrive as 401 (learned the hard way here).
    log.error(`TTS HTTP ${resp.status}: ${body.slice(0, 300)}`);
    throw new Error(`TTS failed (HTTP ${resp.status})`);
  }
  return { resp, voice };
}

export async function synthesize(text, { voiceId } = {}) {
  const { resp, voice } = await request(text, voiceId);
  const id = randomUUID();
  const filename = `${id}.${audioExt}`;
  const path = join(AUDIO_DIR, filename);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(path, buf);
  log.info(`synthesized ${text.length} chars as ${voice} -> ${filename} (${buf.length}B)`);
  recordUsage('speechmatics', 'tts', 'speechmatics_tts_char', text.length);
  return { id, path, filename, voiceId: voice, chars: text.length };
}

// Progressive playback: hand back the response body so the first audio reaches
// the client while the rest is still arriving. Usage is recorded here rather
// than on completion — the characters are billed the moment the request is
// accepted, whether or not the listener stays to the end.
export async function synthesizeStream(text, { voiceId } = {}) {
  const { resp, voice } = await request(text, voiceId);
  if (!resp.body) throw new Error('TTS response had no body to stream');
  recordUsage('speechmatics', 'tts', 'speechmatics_tts_char', text.length);
  return { stream: resp.body, voiceId: voice };
}
