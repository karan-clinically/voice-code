// Live speech-to-text relay at /ws/stt. The client streams raw audio frames
// (binary WebSocket messages — MediaRecorder Opus/webm chunks) the moment the
// mic is held; the harness relays them to Deepgram and forwards transcripts back:
//   server -> client  {type:'stt_partial', text}   running transcript (interim +
//                                                    committed) — render live in
//                                                    the command box
//                     {type:'stt_final', text}      settled text on mic release
//                     {type:'error', error, spoken} Deepgram failed mid-stream;
//                                                    the client falls back to a
//                                                    batch upload of the clip
//   client -> server  <binary>                       raw audio frame
//                     {t:'done'}                     mic released — flush + finalize
//
// Auth mirrors /ws and /ws/term (localhost allowed; remote needs ?token=),
// applied in ws.js before the upgrade is handed here. The Deepgram key never
// leaves the harness. Nothing here ever reaches a pty — the final text lands in
// the client's editable box for review; injection happens only on an explicit
// Send.

import { WebSocketServer } from 'ws';
import { createStream } from '../services/stt/index.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('wsStt');
const FINALIZE_GRACE_MS = 1000; // wait for Deepgram's trailing finals after Finalize

export function createSttWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, req) => {
    let language = null;
    try {
      language = new URL(req.url, 'http://localhost').searchParams.get('lang') || null;
    } catch {
      language = null;
    }

    let stream = null;
    let ready = false;
    let finished = false;
    const pending = []; // audio frames that arrived before the Deepgram socket was ready

    const sendFinal = (text) => {
      if (finished) return;
      finished = true;
      send(ws, { type: 'stt_final', text: (text || '').trim() });
    };

    try {
      stream = await createStream({
        language,
        onPartial: (text) => send(ws, { type: 'stt_partial', text }),
        onError: (err) => {
          log.warn(`deepgram stream error: ${err?.message || err}`);
          send(ws, { type: 'error', error: String(err?.message || err), spoken: 'Transcription failed' });
        },
        onClose: (finalized) => sendFinal(finalized),
      });
    } catch (err) {
      log.error(`could not open stt stream: ${err.message}`);
      send(ws, { type: 'error', error: err.message, spoken: 'Voice transcription is unavailable' });
      ws.close();
      return;
    }

    ready = true;
    for (const chunk of pending) stream.sendAudio(chunk);
    pending.length = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ready) stream.sendAudio(data);
        else pending.push(data);
        return;
      }
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.t === 'done') {
        // Flush buffered audio and ask Deepgram to close; emit the settled text
        // once its trailing finals land (or after a short grace, whichever first).
        stream.finish();
        setTimeout(() => {
          sendFinal(stream.getText());
          stream.close();
        }, FINALIZE_GRACE_MS);
      }
    });

    ws.on('close', () => {
      // Mic released / tab closed — close the Deepgram socket promptly so we do
      // not pay for an idle stream.
      if (stream) stream.close();
    });

    log.debug('stt client attached');
  });

  return wss;
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* client went away */
    }
  }
}
