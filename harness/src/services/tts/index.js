// Text-to-speech facade. Two providers behind one contract, mirroring services/stt:
//   isConfigured() · getVoiceId() · synthesize(text, {voiceId}) · listVoices()
// synthesize() returns { id, path, filename, voiceId, chars } — an .mp3 in
// AUDIO_DIR, so every downstream consumer (interactions.audio_path, /api/tts/:id
// replay, desktop speaker, phone <audio>) is provider-agnostic.
//
// Trade-off worth knowing: ElevenLabs voices are more expressive/natural;
// Deepgram Aura-2 is utility-grade — clear and fast, built for agent replies
// rather than narration. Aura-2 needs no extra signup (same key as STT).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIO_DIR } from '../../db.js';
import { getConfig } from '../../config.js';
import * as elevenlabs from './providers/elevenlabs.js';
import * as deepgram from './providers/deepgram.js';

export const providers = { elevenlabs, deepgram };

// Which provider speaks. An explicit `tts_provider` wins. Otherwise: keep using
// ElevenLabs if it is already set up (don't silently change an existing install's
// voice), else fall back to Deepgram — which a fresh install always has, because
// the same key already powers STT.
export function activeProviderName() {
  const explicit = getConfig('tts_provider');
  if (providers[explicit]) return explicit;
  if (elevenlabs.isConfigured() && elevenlabs.getVoiceId()) return 'elevenlabs';
  return 'deepgram';
}

export function activeProvider() {
  return providers[activeProviderName()];
}

// True when the active provider can actually speak (key + voice present).
export function isConfigured() {
  const p = activeProvider();
  return p.isConfigured() && !!p.getVoiceId();
}

export function getVoiceId(provider) {
  return (providers[provider] || activeProvider()).getVoiceId();
}

export async function synthesize(text, { provider, voiceId } = {}) {
  const name = providers[provider] ? provider : activeProviderName();
  const out = await providers[name].synthesize(text, { voiceId });
  return { ...out, provider: name };
}

// Progressive synthesis: returns the audio stream immediately so a client can
// start playing on the first frames, plus `done` — a promise that resolves once
// a full copy has been tee'd to the audio cache, so replay works exactly as
// before. Both branches of the tee are drained independently, so the cache is
// still written even if the listener hangs up early.
export async function synthesizeStream(text, { provider, voiceId } = {}) {
  const name = providers[provider] ? provider : activeProviderName();
  const { stream, voiceId: voice } = await providers[name].synthesizeStream(text, { voiceId });

  const id = randomUUID();
  const filename = `${id}.mp3`;
  const path = join(AUDIO_DIR, filename);
  const [toClient, toCache] = stream.tee();

  const done = (async () => {
    const chunks = [];
    const reader = toCache.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(Buffer.from(value));
    }
    await writeFile(path, Buffer.concat(chunks));
    return { id, path, filename, provider: name, voiceId: voice, chars: text.length };
  })();

  return { stream: toClient, done, provider: name, voiceId: voice };
}

export async function listVoices(provider) {
  const name = providers[provider] ? provider : activeProviderName();
  return providers[name].listVoices();
}
