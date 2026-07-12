// Deepgram speech-to-text provider (batch + live streaming).
//
//   batch : @deepgram/sdk v5 — client.listen.v1.media.transcribeFile(buffer,
//           { model, smart_format }) -> results.channels[0].alternatives[0].transcript
//
//   stream: RAW `ws`, deliberately NOT the SDK. The SDK's listen.v1.connect()
//           socket does not send the Authorization header under Node: Deepgram
//           rejects the handshake and closes immediately, while the SDK's
//           waitForOpen() never settles — a silent hang with no error. The plain
//           WebSocket below, with `Authorization: Token <key>`, connects fine.
//             wss://api.deepgram.com/v1/listen?model=…&encoding=linear16&…
//             client -> binary PCM frames; {"type":"KeepAlive"|"Finalize"|"CloseStream"}
//             server -> {type:'Results', is_final, channel:{alternatives:[{transcript}]}}
//
// Streaming audio is raw linear16 @16kHz mono (see services/stt/index.js for why),
// so encoding/sample_rate must be declared. The key never leaves the harness.

import WebSocket from 'ws';
import { getConfig } from '../../../config.js';
import { deepgramClient as client, deepgramKey } from '../../deepgramClient.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('stt:deepgram');
const WS_URL = 'wss://api.deepgram.com/v1/listen';
const DEFAULT_MODEL = 'nova-3';
const MAX_BYTES = 25 * 1024 * 1024;
const SAMPLE_RATE = 16000;
const KEEPALIVE_MS = 8000; // Deepgram drops the socket after ~10s of no audio.

export function isConfigured() {
  return !!deepgramKey();
}

export async function transcribeBatch(buffer, { model, language } = {}) {
  if (!buffer || buffer.length === 0) throw new Error('empty audio buffer');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`audio exceeds ${MAX_BYTES} byte limit (${buffer.length} bytes)`);
  }
  const m = model || getConfig('stt_model', DEFAULT_MODEL);
  const req = { model: m, smart_format: true };
  if (language) req.language = language;

  let res;
  try {
    res = await client().listen.v1.media.transcribeFile(buffer, req);
  } catch (err) {
    log.error(`batch transcription failed: ${err.message}`);
    throw new Error(`transcription failed: ${err.message}`);
  }
  const text = (res?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
  log.info(`batch transcribed ${buffer.length}B via ${m} -> ${text.length} chars`);
  return text;
}

// Opens a live Deepgram connection and returns a small controller. The caller
// (wsStt.js) feeds raw audio frames and receives running text via onPartial; the
// accumulated final text is available through getText()/onClose. Deepgram emits
// several is_final segments per utterance, so we concatenate them ourselves.
export async function createStream({ model, language, onOpen, onPartial, onError, onClose } = {}) {
  const key = deepgramKey();
  if (!key) throw new Error('Deepgram API key not configured');
  const m = model || getConfig('stt_model', DEFAULT_MODEL);

  // Raw linear16 @16kHz, matching what the clients now capture, so encoding and
  // sample_rate must be declared (Deepgram would auto-detect a container, but
  // ElevenLabs' realtime endpoint cannot take one — both get identical PCM).
  const qs = new URLSearchParams({
    model: m,
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
  });
  if (language) qs.set('language', language);

  const ws = new WebSocket(`${WS_URL}?${qs.toString()}`, {
    headers: { Authorization: `Token ${key}` },
  });

  let finalized = '';
  const withInterim = (interim) => (finalized && interim ? finalized + ' ' + interim : finalized || interim);

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (err) => reject(new Error(err.message)));
      ws.once('close', (code) => reject(new Error(`Deepgram closed the socket (${code})`)));
      setTimeout(() => reject(new Error('Deepgram handshake timed out')), 10000);
    });
  } catch (err) {
    log.error(`stream connect failed: ${err.message}`);
    throw new Error(`stream connect failed: ${err.message}`);
  }
  onOpen?.();

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const t = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
    if (!t) return;
    if (msg.is_final) {
      finalized = finalized ? finalized + ' ' + t : t;
      onPartial?.(finalized);
    } else {
      onPartial?.(withInterim(t));
    }
  });
  ws.on('error', (err) => onError?.(err));
  ws.on('close', () => onClose?.(finalized));

  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const ka = setInterval(() => sendJson({ type: 'KeepAlive' }), KEEPALIVE_MS);

  return {
    sendAudio(chunk) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      } catch (err) {
        onError?.(err);
      }
    },
    // Flush buffered audio and ask Deepgram to close cleanly (stops billing).
    finish() {
      try {
        sendJson({ type: 'Finalize' });
        sendJson({ type: 'CloseStream' });
      } catch {
        /* already closing */
      }
    },
    close() {
      clearInterval(ka);
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
