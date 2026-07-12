// Speech-to-text facade. Two providers behind one contract, mirroring services/tts:
//   isConfigured() · transcribeBatch(buffer, opts) · createStream(handlers)
// so the whole voice loop (STT + TTS) can run on a single vendor — all-Deepgram
// or all-ElevenLabs — see `stt_provider` / `tts_provider`.
//
// Streaming audio is raw linear16 @16kHz mono for BOTH providers. Deepgram would
// happily auto-detect a webm/opus container, but ElevenLabs' realtime endpoint
// accepts only raw PCM — so the clients capture PCM and both providers consume
// the same bytes rather than each getting its own format.

import { getConfig } from '../../config.js';
import * as deepgram from './providers/deepgram.js';
import * as elevenlabs from './providers/elevenlabs.js';

export const providers = { deepgram, elevenlabs };

// Which provider listens. An explicit `stt_provider` wins; otherwise Deepgram if
// its key is present (it has always been the STT default), else ElevenLabs.
export function activeProviderName() {
  const explicit = getConfig('stt_provider');
  if (providers[explicit]) return explicit;
  if (deepgram.isConfigured()) return 'deepgram';
  if (elevenlabs.isConfigured()) return 'elevenlabs';
  return 'deepgram';
}

export function activeProvider() {
  return providers[activeProviderName()];
}

export function isConfigured() {
  return activeProvider().isConfigured();
}

// Full-clip transcription (POST /api/transcribe). Returns the transcript string.
export function transcribeBatch(buffer, opts = {}) {
  const name = providers[opts.provider] ? opts.provider : activeProviderName();
  return providers[name].transcribeBatch(buffer, opts);
}

// Live streaming session (see wsStt.js). Returns a controller with
// sendAudio(chunk) / finish() / close() / getText().
export function createStream(handlers = {}) {
  const name = providers[handlers.provider] ? handlers.provider : activeProviderName();
  return providers[name].createStream(handlers);
}
