// OpenAI speech-to-text. Endpoint + models verified against current docs
// (developers.openai.com, July 2026): POST /v1/audio/transcriptions, models
// whisper-1 | gpt-4o-transcribe | gpt-4o-mini-transcribe, 25MB limit.
// Default model is gpt-4o-mini-transcribe (cheaper + better than whisper-1 for
// short command dictation); override with the `stt_model` config key.
// Uses Node's native fetch/FormData/Blob — no HTTP client dependency.

import { getConfig } from '../config.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('whisper');
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

export async function transcribe(audioBuffer, filename = 'audio.wav', { model, language } = {}) {
  const apiKey = getConfig('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API key not configured');
  if (!audioBuffer || audioBuffer.length === 0) throw new Error('empty audio buffer');
  if (audioBuffer.length > MAX_BYTES) {
    throw new Error(`audio exceeds 25MB limit (${audioBuffer.length} bytes)`);
  }

  const sttModel = model || getConfig('stt_model', DEFAULT_MODEL);
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', sttModel);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    log.error(`transcription request failed: ${err.message}`);
    throw new Error(`transcription request failed: ${err.message}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    log.error(`transcription HTTP ${resp.status}: ${body.slice(0, 300)}`);
    throw new Error(`transcription failed (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  const text = (data.text || '').trim();
  log.info(`transcribed ${audioBuffer.length}B via ${sttModel} -> ${text.length} chars`);
  return text;
}
