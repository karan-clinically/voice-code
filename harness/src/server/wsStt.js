// Live speech-to-text relay at /ws/stt. The client streams raw audio frames
// (binary WebSocket messages — MediaRecorder Opus/webm chunks) the moment the
// mic is held; the harness relays them to Deepgram and forwards transcripts back:
//   server -> client  {type:'stt_partial', text}   running transcript (interim +
//                                                    committed) — render live in
//                                                    the command box
//                     {type:'stt_final', text, tidying}
//                                                   verbatim text on mic release;
//                                                    tidying=true means a cleaned
//                                                    version is on its way
//                     {type:'stt_cleaned', text}    Wispr-style tidied text — swap
//                                                    it in unless the user has
//                                                    already edited the box
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
import { getConfig } from '../config.js';
import { createStream } from '../services/stt/index.js';
import { refineTranscript } from '../services/refine.js';
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

    // Two-stage finish. Deepgram gives us a verbatim transcript (smart_format adds
    // punctuation/casing, nothing more) — it does NOT organise your thoughts. So we
    // send the raw text the instant the mic is released, keeping the live-dictation
    // feel, then run the Wispr-style cleanup pass (services/refine.js: strips
    // fillers and false starts, tightens the phrasing) and send the tidied version
    // a beat later. The client swaps it in unless the user has already touched the
    // box. Cleanup is fail-open, so a missing OpenAI key just means no second event.
    const sendFinal = async (text) => {
      if (finished) return;
      finished = true;
      const raw = (text || '').trim();
      const wantCleanup = raw && getConfig('dictation_cleanup', 'on') !== 'off';
      send(ws, { type: 'stt_final', text: raw, tidying: !!wantCleanup });
      if (!wantCleanup) return;
      try {
        const cleaned = (await refineTranscript(raw)).trim();
        // Only speak up if it actually changed — no pointless re-render.
        if (cleaned && cleaned !== raw) send(ws, { type: 'stt_cleaned', text: cleaned });
        else send(ws, { type: 'stt_cleaned', text: raw });
      } catch (err) {
        log.warn(`cleanup failed: ${err.message}`);
        send(ws, { type: 'stt_cleaned', text: raw }); // clear the client's "tidying…" state
      }
    };

    // Attach the message handler BEFORE opening the provider socket. Opening it
    // takes 1-2s, and the mic is already running — if we only started listening
    // afterwards, every frame spoken during the handshake would hit a socket with
    // no 'message' listener and be dropped on the floor, eating the first second
    // or two of every utterance. Buffer those frames instead and flush on ready.
    let doneRequested = false;
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
        if (!ready) {
          doneRequested = true; // mic released mid-handshake; finalize once open
          return;
        }
        finalize();
      }
    });

    // Flush buffered audio, ask the provider to close, and emit the settled text
    // once its trailing finals land (or after a short grace, whichever is first).
    const finalize = () => {
      stream.finish();
      setTimeout(() => {
        sendFinal(stream.getText());
        stream.close();
      }, FINALIZE_GRACE_MS);
    };

    try {
      stream = await createStream({
        language,
        onPartial: (text) => send(ws, { type: 'stt_partial', text }),
        onError: (err) => {
          log.warn(`stt stream error: ${err?.message || err}`);
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
    if (doneRequested) finalize(); // they finished speaking before we were ready

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
