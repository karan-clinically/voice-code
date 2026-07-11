// Audio: one reused <audio> element unlocked on first gesture (mobile autoplay),
// a tap recorder, and a voice-activity-detection conversation loop (retained for
// the hidden conversation mode).

const SILENT =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

let player = null;
let unlocked = false;

export function initAudio() {
  if (player) return;
  player = document.createElement('audio');
  player.setAttribute('playsinline', '');
  player.style.display = 'none';
  document.body.appendChild(player);
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    try {
      player.src = SILENT;
      const p = player.play();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('touchend', unlock, { once: true, passive: true });
  document.addEventListener('click', unlock, { once: true });
}

export function playUrl(u) {
  return new Promise((resolve) => {
    try {
      player.src = u;
      player.onended = () => {
        player.onended = null;
        resolve();
      };
      const p = player.play();
      if (p && p.catch) p.catch(() => resolve());
    } catch {
      resolve();
    }
  });
}

export function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// Tap-to-record: call start(); returns a handle with .stop(). onDone(blob, ext).
export async function tapRecord(onDone, onErr) {
  if (!navigator.mediaDevices?.getUserMedia) {
    onErr && onErr('Microphone needs HTTPS');
    return null;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    onErr && onErr('Mic: ' + e.message);
    return null;
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
    onDone(new Blob(chunks, { type }), ext);
  };
  rec.start();
  return { stop: () => rec.state !== 'inactive' && rec.stop() };
}

// Voice-activity-detection conversation loop (retained; used by hidden mode).
const SPEECH_RMS = 0.03;
const SILENCE_MS = 1500;
const MIN_SPEECH_MS = 350;
const MAX_TURN_MS = 30000;

export class Conversation {
  constructor({ onStatus, onTurn }) {
    this.onStatus = onStatus || (() => {});
    this.onTurn = onTurn; // async (blob, ext) => void
    this.on = false;
  }
  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.onStatus('mic error: ' + e.message);
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.on = true;
    this.listen();
    return true;
  }
  stop() {
    this.on = false;
    if (this.tId) clearTimeout(this.tId);
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) try { this.ctx.close(); } catch {}
    this.analyser = null;
    this.onStatus('');
  }
  listen() {
    if (!this.on) return;
    this.onStatus('🎧 listening…');
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.process();
    this.rec.start();
    this.speech = false;
    this.silenceStart = 0;
    this.speechStart = 0;
    this.startAt = performance.now();
    this.monitor();
  }
  monitor() {
    if (!this.on || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (rms > SPEECH_RMS) {
      if (!this.speech) {
        this.speech = true;
        this.speechStart = now;
        this.onStatus('🗣️ recording…');
      }
      this.silenceStart = 0;
    } else if (this.speech) {
      if (!this.silenceStart) this.silenceStart = now;
      else if (now - this.silenceStart > SILENCE_MS && now - this.speechStart > MIN_SPEECH_MS) return this.endTurn();
    }
    if (this.speech && now - this.startAt > MAX_TURN_MS) return this.endTurn();
    this.tId = setTimeout(() => this.monitor(), 80);
  }
  endTurn() {
    if (this.tId) clearTimeout(this.tId);
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {}
  }
  async process() {
    const chunks = this.chunks;
    this.chunks = [];
    if (!this.on) return;
    if (!chunks.length || !this.speech) {
      this.listen();
      return;
    }
    const type = this.rec.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
    this.onStatus('💭 working…');
    try {
      await this.onTurn(new Blob(chunks, { type }), ext);
    } catch (e) {
      this.onStatus('error: ' + e.message);
    }
    if (this.on) this.listen();
  }
}
