// Deepgram speech-to-text provider (batch + live streaming) via the official
// @deepgram/sdk v5. API surface verified against the installed SDK's type defs:
//   batch : client.listen.v1.media.transcribeFile(buffer, { model, smart_format })
//           -> results.channels[0].alternatives[0].transcript
//   stream: client.listen.v1.connect({ model, interim_results, smart_format,
//           endpointing, Authorization }) -> V1Socket (sendMedia / sendKeepAlive /
//           sendFinalize / sendCloseStream / .on('message'|'error'|'close'))
// The API key never leaves the harness (config key `deepgram_api_key`, env
// DEEPGRAM_API_KEY). Audio is sent as-is; Deepgram auto-detects the container
// (webm/opus from MediaRecorder, wav, mp3…) so no encoding param is needed.

import { DeepgramClient } from '@deepgram/sdk';
import { getConfig } from '../../../config.js';
import { makeLogger } from '../../../util/logger.js';

const log = makeLogger('stt:deepgram');
const DEFAULT_MODEL = 'nova-3';
const MAX_BYTES = 25 * 1024 * 1024;
const KEEPALIVE_MS = 8000; // Deepgram drops the socket after ~10s of no audio.

let cached = { key: null, client: null };
function client() {
  const key = getConfig('deepgram_api_key');
  if (!key) throw new Error('Deepgram API key not configured');
  if (cached.key !== key) cached = { key, client: new DeepgramClient({ apiKey: key }) };
  return cached.client;
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
  const key = getConfig('deepgram_api_key');
  if (!key) throw new Error('Deepgram API key not configured');
  const m = model || getConfig('stt_model', DEFAULT_MODEL);

  const args = {
    model: m,
    interim_results: true,
    smart_format: true,
    endpointing: 300,
    Authorization: `Token ${key}`,
  };
  if (language) args.language = language;

  let socket;
  try {
    socket = await client().listen.v1.connect(args);
  } catch (err) {
    log.error(`stream connect failed: ${err.message}`);
    throw new Error(`stream connect failed: ${err.message}`);
  }

  let finalized = '';
  const withInterim = (interim) => (finalized && interim ? finalized + ' ' + interim : finalized || interim);

  socket.on('open', () => onOpen?.());
  socket.on('message', (msg) => {
    if (!msg || msg.type !== 'Results') return;
    const t = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
    if (!t) return;
    if (msg.is_final) {
      finalized = finalized ? finalized + ' ' + t : t;
      onPartial?.(finalized);
    } else {
      onPartial?.(withInterim(t));
    }
  });
  socket.on('error', (err) => onError?.(err));
  socket.on('close', () => onClose?.(finalized));

  const ka = setInterval(() => {
    try {
      socket.sendKeepAlive({ type: 'KeepAlive' });
    } catch {
      /* socket already gone */
    }
  }, KEEPALIVE_MS);

  return {
    sendAudio(chunk) {
      try {
        socket.sendMedia(chunk);
      } catch (err) {
        onError?.(err);
      }
    },
    // Flush any buffered audio and ask Deepgram to close cleanly (stops billing).
    finish() {
      try {
        socket.sendFinalize({ type: 'Finalize' });
        socket.sendCloseStream({ type: 'CloseStream' });
      } catch {
        /* already closing */
      }
    },
    close() {
      clearInterval(ka);
      try {
        socket.close();
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
