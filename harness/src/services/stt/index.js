// Speech-to-text service facade. One provider today (Deepgram); the shape
//   { providers, transcribeBatch, createStream }
// keeps room for OpenAI / local faster-whisper later without touching the routes
// or the WebSocket relay — add a provider module and switch on a config key here.

import * as deepgram from './providers/deepgram.js';

export const providers = { deepgram };

function active() {
  // Reserved for a future `stt_provider` config key; only Deepgram exists now.
  return providers.deepgram;
}

// Full-clip transcription (POST /api/transcribe). Returns the transcript string.
export function transcribeBatch(buffer, opts) {
  return active().transcribeBatch(buffer, opts);
}

// Live streaming session (see wsStt.js). Returns a controller with
// sendAudio(chunk) / finish() / close() / getText().
export function createStream(handlers) {
  return active().createStream(handlers);
}
