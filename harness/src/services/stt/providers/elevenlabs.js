// ElevenLabs speech-to-text (Scribe), so the whole voice loop can run on one
// vendor. Endpoints verified against current docs (July 2026):
//   batch : POST https://api.elevenlabs.io/v1/speech-to-text
//           multipart {file, model_id}, header xi-api-key -> { text }
//   stream: wss://api.elevenlabs.io/v1/speech-to-text/realtime
//           ?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad
//           client -> {message_type:'input_audio_chunk', audio_base_64, sample_rate, commit}
//           server -> {message_type:'partial_transcript'|'committed_transcript', text}
//
// IMPORTANT: unlike Deepgram, the realtime endpoint does NOT accept containerised
// audio (webm/opus) — only raw PCM. That is why the browser clients capture
// linear16 @16kHz rather than using MediaRecorder. Both providers consume it.

import WebSocket from 'ws';
import { getConfig } from '../../../config.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('stt:elevenlabs');
const BASE = 'https://api.elevenlabs.io/v1';
const WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const DEFAULT_BATCH_MODEL = 'scribe_v1';
const DEFAULT_STREAM_MODEL = 'scribe_v2_realtime';
const SAMPLE_RATE = 16000;
const MAX_BYTES = 25 * 1024 * 1024;

export function isConfigured() {
  return !!getConfig('elevenlabs_api_key');
}

export async function transcribeBatch(buffer, { model, language } = {}) {
  const apiKey = getConfig('elevenlabs_api_key');
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  if (!buffer || buffer.length === 0) throw new Error('empty audio buffer');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`audio exceeds ${MAX_BYTES} byte limit (${buffer.length} bytes)`);
  }

  const m = model || getConfig('elevenlabs_stt_model', DEFAULT_BATCH_MODEL);
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'audio.webm');
  form.append('model_id', m);
  if (language) form.append('language_code', language);

  let resp;
  try {
    resp = await fetch(`${BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
  } catch (err) {
    log.error(`batch transcription failed: ${err.message}`);
    throw new Error(`transcription failed: ${err.message}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    log.error(`transcription HTTP ${resp.status}: ${body.slice(0, 200)}`);
    throw new Error(`transcription failed (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  const text = (data.text || '').trim();
  log.info(`batch transcribed ${buffer.length}B via ${m} -> ${text.length} chars`);
  return text;
}

// Live transcription. Same controller contract as the Deepgram provider:
// sendAudio(pcmChunk) / finish() / close() / getText(). Audio in is raw linear16
// @16kHz mono, which the socket wants base64'd inside a JSON envelope.
export async function createStream({ model, language, onOpen, onPartial, onError, onClose } = {}) {
  const apiKey = getConfig('elevenlabs_api_key');
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  const m = model || getConfig('elevenlabs_stt_stream_model', DEFAULT_STREAM_MODEL);

  const qs = new URLSearchParams({
    model_id: m,
    audio_format: `pcm_${SAMPLE_RATE}`,
    commit_strategy: 'vad', // segments commit themselves as you pause
  });
  if (language) qs.set('language_code', language);

  const ws = new WebSocket(`${WS_URL}?${qs.toString()}`, { headers: { 'xi-api-key': apiKey } });

  let finalized = '';
  const withInterim = (interim) => (finalized && interim ? finalized + ' ' + interim : finalized || interim);

  // Audio sent between 'open' and the server's `session_started` handshake is
  // discarded — which silently ate the first second or so of every utterance.
  // Do not report the stream ready until the session actually exists.
  await new Promise((resolve, reject) => {
    const onMsg = (buf) => {
      let m2;
      try {
        m2 = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m2.message_type === 'session_started') {
        ws.off('message', onMsg);
        resolve();
      } else if (m2.message_type === 'auth_error') {
        ws.off('message', onMsg);
        reject(new Error(m2.message || 'ElevenLabs auth failed'));
      }
    };
    ws.on('message', onMsg);
    ws.once('error', (err) => reject(new Error(`stream connect failed: ${err.message}`)));
    setTimeout(() => reject(new Error('ElevenLabs realtime handshake timed out')), 10000);
  });
  onOpen?.();

  ws.on('message', (buf) => {
    let m2;
    try {
      m2 = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const t = (m2.text || '').trim();
    if (m2.message_type === 'committed_transcript') {
      if (!t) return;
      finalized = finalized ? finalized + ' ' + t : t;
      onPartial?.(finalized);
    } else if (m2.message_type === 'partial_transcript') {
      if (!t) return;
      onPartial?.(withInterim(t));
    } else if (m2.message_type && m2.message_type.endsWith('error')) {
      onError?.(new Error(m2.message || m2.message_type));
    }
  });
  ws.on('error', (err) => onError?.(err));
  ws.on('close', () => onClose?.(finalized));

  const sendChunk = (chunk, commit) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(chunk).toString('base64'),
        sample_rate: SAMPLE_RATE,
        commit,
      })
    );
  };

  return {
    sendAudio(chunk) {
      try {
        sendChunk(chunk, false);
      } catch (err) {
        onError?.(err);
      }
    },
    // Mic released: flush whatever is buffered and force a final commit.
    finish() {
      try {
        sendChunk(Buffer.alloc(0), true);
      } catch {
        /* already closing */
      }
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return finalized;
    },
    getText() {
      return finalized;
    },
  };
}
