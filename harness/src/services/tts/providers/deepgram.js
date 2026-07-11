// Deepgram Aura-2 text-to-speech, via the same @deepgram/sdk client (and the same
// key + credit pool) the STT side already uses. API surface verified against the
// installed SDK's type defs:
//   client.speak.v1.audio.generate({ text, model, encoding }) -> BinaryResponse
// `encoding: 'mp3'` keeps the whole downstream path identical to ElevenLabs —
// an .mp3 in AUDIO_DIR, replayed via /api/tts/:id, played by the PowerShell
// MediaPlayer on desktop and <audio> on the phone.
//
// Streaming (client.speak.v1.connect) is deliberately NOT used yet: the local
// player takes a file path, not a stdin pipe. Aura-2's fast time-to-first-byte
// still makes the batch render quick. Streaming playback is a follow-up.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpeakV1Model } from '@deepgram/sdk';
import { AUDIO_DIR } from '../../../db.js';
import { getConfig } from '../../../config.js';
import { deepgramClient, deepgramKey } from '../../deepgramClient.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('tts:deepgram');
const DEFAULT_VOICE = 'aura-2-thalia-en';

export const label = 'Deepgram Aura-2';

// The SDK ships the full model enum, so the picker needs neither a hand-kept list
// nor a network call. Aura-2 only — the original Aura voices are superseded.
const AURA2 = Object.values(SpeakV1Model)
  .filter((m) => typeof m === 'string' && m.startsWith('aura-2-'))
  .sort();

// "aura-2-thalia-en" -> "Thalia"
function prettyName(id) {
  const part = id.replace(/^aura-2-/, '').replace(/-[a-z]{2}$/, '');
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function isConfigured() {
  return !!deepgramKey();
}

export function getVoiceId() {
  const v = getConfig('deepgram_tts_voice');
  if (v) return v;
  return AURA2.includes(DEFAULT_VOICE) ? DEFAULT_VOICE : AURA2[0] || null;
}

export async function synthesize(text, { voiceId } = {}) {
  if (!deepgramKey()) throw new Error('Deepgram API key not configured');
  if (!text || !text.trim()) throw new Error('empty text');
  const voice = voiceId || getVoiceId();
  if (!voice) throw new Error('no Deepgram voice selected');

  let res;
  try {
    res = await deepgramClient().speak.v1.audio.generate({ text, model: voice, encoding: 'mp3' });
  } catch (err) {
    log.error(`TTS request failed: ${err.message}`);
    throw new Error(`TTS failed: ${err.message}`);
  }

  const id = randomUUID();
  const filename = `${id}.mp3`;
  const path = join(AUDIO_DIR, filename);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
  log.info(`synthesized ${text.length} chars via ${voice} -> ${filename} (${buf.length}B)`);
  return { id, path, filename, voiceId: voice, chars: text.length };
}

export async function listVoices() {
  return AURA2.map((id) => ({ voice_id: id, name: prettyName(id), category: 'aura-2' }));
}
