// One Deepgram client for the whole harness — STT (listen) and TTS (speak) share
// the same key, the same $200 free credit pool, and the same client instance.
// Rebuilt only when the configured key changes.

import { DeepgramClient } from '@deepgram/sdk';
import { getConfig } from '../config.js';

let cached = { key: null, client: null };

export function deepgramKey() {
  return getConfig('deepgram_api_key');
}

export function deepgramClient() {
  const key = deepgramKey();
  if (!key) throw new Error('Deepgram API key not configured');
  if (cached.key !== key) cached = { key, client: new DeepgramClient({ apiKey: key }) };
  return cached.client;
}
