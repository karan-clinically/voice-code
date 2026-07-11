// Text-to-speech facade. Two providers behind one contract, mirroring services/stt:
//   isConfigured() · getVoiceId() · synthesize(text, {voiceId}) · listVoices()
// synthesize() returns { id, path, filename, voiceId, chars } — an .mp3 in
// AUDIO_DIR, so every downstream consumer (interactions.audio_path, /api/tts/:id
// replay, desktop speaker, phone <audio>) is provider-agnostic.
//
// Trade-off worth knowing: ElevenLabs voices are more expressive/natural;
// Deepgram Aura-2 is utility-grade — clear and fast, built for agent replies
// rather than narration. Aura-2 needs no extra signup (same key as STT).

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

export async function listVoices(provider) {
  const name = providers[provider] ? provider : activeProviderName();
  return providers[name].listVoices();
}
