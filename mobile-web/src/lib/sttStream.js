// Live dictation client for the /ws/stt relay (phone). Streams MediaRecorder
// Opus chunks as the mic is held; onPartial gives a running transcript to render
// live in the command box, onFinal the settled text on release. If Deepgram fails
// mid-stream, onError gets { error, spoken, recovered } where `recovered` is the
// full recorded Blob so the caller can retry the same utterance as a batch upload.

import { pickMime } from './audio.js';

export async function startSttStream({ wsUrl, onPartial, onFinal, onError }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMime();
  const chunks = [];
  let finished = false;

  const releaseMic = () => {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
  };

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === 'stt_partial') onPartial?.(m.text || '');
    else if (m.type === 'stt_final') {
      if (!finished) {
        finished = true;
        onFinal?.(m.text || '');
      }
    } else if (m.type === 'error') {
      const recovered = chunks.length ? new Blob(chunks, { type: mimeType || 'audio/webm' }) : null;
      onError?.({ error: m.error, spoken: m.spoken, recovered });
    }
  };

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('voice stream could not connect')), { once: true });
    });
  } catch (err) {
    releaseMic();
    throw err;
  }

  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    // Blobs go straight out — WebSocket.send preserves order, so Deepgram sees a
    // contiguous webm/opus byte stream.
    if (ws.readyState === 1) ws.send(e.data);
  };
  mr.start(250);

  return {
    stop() {
      try {
        if (mr.state !== 'inactive') mr.stop();
      } catch {
        /* ignore */
      }
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'done' }));
      } catch {
        /* ignore */
      }
      releaseMic();
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 3000);
    },
    abort() {
      finished = true;
      try {
        if (mr.state !== 'inactive') mr.stop();
      } catch {
        /* ignore */
      }
      releaseMic();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
