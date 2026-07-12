// Live dictation client for the /ws/stt relay.
//
// Captures raw linear16 PCM @16kHz mono rather than using MediaRecorder. That is
// not a preference: ElevenLabs' realtime STT accepts only raw PCM, so sending a
// webm/opus container (which Deepgram would have auto-detected quite happily)
// would have locked live dictation to one vendor. Both providers now consume the
// same PCM bytes.
//
// onPartial(text)              running transcript — render live in the box
// onFinal(text, {tidying})     verbatim text on mic release
// onCleaned(text)              Wispr-style tidied rewrite, a beat later
// onError({error, spoken, recovered})
//     `recovered` is a WAV Blob of everything captured, so a stream that dies
//     mid-utterance can be retried as a one-shot batch upload.

const TARGET_RATE = 16000;

function floatToPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Browsers may ignore the requested AudioContext rate (Safari often does), so
// resample to 16kHz ourselves when they hand us something else.
function downsample(f32, from, to) {
  if (from === to) return f32;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = f32[Math.floor(i * ratio)];
  return out;
}

// Minimal 16-bit mono WAV wrapper for the batch-fallback blob.
function pcmToWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, total * 2, true);
  let off = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, off += 2) view.setInt16(off, c[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

export async function startSttStream({ wsUrl, onPartial, onFinal, onCleaned, onError }) {
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const captured = []; // Int16Array chunks, kept for the batch fallback
  let finished = false;

  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
  const release = () => {
    try {
      media.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    ctx.close().catch(() => {});
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
        onFinal?.(m.text || '', { tidying: !!m.tidying });
      }
    } else if (m.type === 'stt_cleaned') {
      onCleaned?.(m.text || '');
    } else if (m.type === 'error') {
      const recovered = captured.length ? pcmToWav(captured, TARGET_RATE) : null;
      onError?.({ error: m.error, spoken: m.spoken, recovered });
    }
  };

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('voice stream could not connect')), { once: true });
    });
  } catch (err) {
    release();
    throw err;
  }

  await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(media);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    const f32 = downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate, TARGET_RATE);
    const pcm = floatToPcm16(f32);
    captured.push(pcm);
    if (ws.readyState === 1) ws.send(pcm.buffer);
  };
  src.connect(node);
  node.connect(ctx.destination);

  const teardown = () => {
    try {
      node.disconnect();
      src.disconnect();
    } catch {
      /* ignore */
    }
    release();
  };

  return {
    // Mic released: stop capturing, ask the harness to finalize.
    stop() {
      teardown();
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'done' }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 4000);
    },
    // Cancel with no transcript (component unmounted).
    abort() {
      finished = true;
      teardown();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
