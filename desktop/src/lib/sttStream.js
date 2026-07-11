// Live dictation client for the /ws/stt relay. Streams MediaRecorder Opus chunks
// to the harness the moment the mic is held and reports a running transcript via
// onPartial (render it live in the command box); onFinal fires with the settled
// text on mic release. If Deepgram fails mid-stream, onError receives
// { error, spoken, recovered } where `recovered` is the full recorded Blob so the
// caller can fall back to a one-shot batch upload of the same utterance.

function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const t of opts) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

export async function startSttStream({ wsUrl, onPartial, onFinal, onError }) {
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
      ws.addEventListener('error', () => reject(new Error('stt socket failed to open')), { once: true });
    });
  } catch (err) {
    releaseMic();
    throw err;
  }

  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    // Send the Blob directly — WebSocket.send preserves order, so the contiguous
    // webm/opus byte stream reaches Deepgram intact.
    if (ws.readyState === 1) ws.send(e.data);
  };
  mr.start(250); // 250ms timeslices → low-latency partials

  return {
    // Mic released: stop recording, flush, and ask the harness to finalize.
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
      // The harness closes the socket after emitting stt_final; close from our
      // side too after a grace in case it doesn't.
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 3000);
    },
    // Cancel with no transcript (component unmounted).
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
