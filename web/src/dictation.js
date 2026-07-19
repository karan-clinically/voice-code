// Dictation: hold the mic button, watch your words appear, release, review, send.
// Voice is review-before-send — the transcript only ever lands in the text box.
//
// Primary path — live streaming: mint a short-lived Deepgram JWT from the
// server, then stream MediaRecorder chunks from the browser straight to
// wss://api.deepgram.com/v1/listen (the serverless host can't relay WebSockets
// the way the old harness did). Containerized webm/opus chunks are sent as-is;
// Deepgram detects the container so no encoding params are declared.
//
// Fallback — batch: if the socket fails (iOS Safari's mp4 chunks aren't
// streamable, restrictive networks), keep recording locally and POST the whole
// blob to /api/transcribe on stop.

import { api } from './api.js';

const DG_WS = 'wss://api.deepgram.com/v1/listen';

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

// Returns a controller: { stop(): Promise<string>, cancel() }.
// onPartial(text) fires with the running transcript (streaming path only).
export async function startDictation({ onPartial, onStatus }) {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const mime = pickMime();
  const recorder = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  let ws = null;
  let finalized = '';
  let streamingOk = false;
  const canStream = !mime.includes('mp4'); // Deepgram live wants webm/opus, not fragmented mp4

  if (canStream) {
    try {
      const { access_token } = await api.sttToken();
      const qs = new URLSearchParams({
        model: 'nova-3',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '300',
        access_token,
      });
      ws = new WebSocket(`${DG_WS}?${qs}`);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('deepgram handshake timeout')), 4000);
        ws.onopen = () => (clearTimeout(t), resolve());
        ws.onerror = () => (clearTimeout(t), reject(new Error('deepgram socket error')));
        ws.onclose = () => (clearTimeout(t), reject(new Error('deepgram socket closed')));
      });
      streamingOk = true;
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type !== 'Results') return;
        const t = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
        if (!t) return;
        if (msg.is_final) {
          finalized = finalized ? `${finalized} ${t}` : t;
          onPartial?.(finalized);
        } else {
          onPartial?.(finalized ? `${finalized} ${t}` : t);
        }
      };
      ws.onerror = ws.onclose = null; // post-handshake drops fall through to batch on stop
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      });
    } catch {
      ws = null;
      streamingOk = false;
    }
  }
  onStatus?.(streamingOk ? 'listening (live)' : 'listening');
  recorder.start(250);

  const stopRecorder = () =>
    new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
      media.getTracks().forEach((t) => t.stop());
    });

  return {
    async stop() {
      await stopRecorder();
      if (streamingOk && ws) {
        // Ask Deepgram to flush remaining audio, then give finals a moment to land.
        try {
          ws.send(JSON.stringify({ type: 'Finalize' }));
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        } catch { /* socket already gone */ }
        await new Promise((r) => setTimeout(r, 700));
        try { ws.close(); } catch { /* noop */ }
        if (finalized) return finalized;
      }
      // Batch fallback (or streaming produced nothing).
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      if (blob.size === 0) return '';
      onStatus?.('transcribing…');
      const { text } = await api.transcribe(blob, mime || 'audio/webm');
      return text;
    },
    cancel() {
      try { recorder.stop(); } catch { /* noop */ }
      media.getTracks().forEach((t) => t.stop());
      try { ws?.close(); } catch { /* noop */ }
    },
  };
}
