// Audio: one reused <audio> element unlocked on first gesture (mobile autoplay),
// a tap recorder, and a voice-activity-detection conversation loop (retained for
// the hidden conversation mode).

const SILENT =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

let player = null;
let unlocked = false;

// --- global playback control ---------------------------------------------------
// One reply plays at a time, wherever it was started (a command reply, a chat
// replay, or a hands-free turn). Whatever is playing registers a small handle here
// so any screen's pause/skip control can drive it without knowing the engine
// (HTMLAudio element vs the hands-free Web Audio context).
let active = null; // { pause, resume, stop, isPaused }
const playbackListeners = new Set();

export function playbackState() {
  return { playing: !!active, paused: !!(active && active.isPaused()) };
}
export function subscribePlayback(fn) {
  playbackListeners.add(fn);
  fn(playbackState());
  return () => playbackListeners.delete(fn);
}
function notifyPlayback() {
  const st = playbackState();
  for (const fn of playbackListeners) fn(st);
}
export function setActivePlayback(handle) {
  active = handle;
  notifyPlayback();
}
export function clearActivePlayback(handle) {
  if (!handle || active === handle) {
    active = null;
    notifyPlayback();
  }
}
export function pausePlayback() {
  if (active) { active.pause(); notifyPlayback(); }
}
export function resumePlayback() {
  if (active) { active.resume(); notifyPlayback(); }
}
export function skipPlayback() {
  if (active) active.stop(); // stop() clears the handle + notifies via its own path
}

export function initAudio() {
  if (player) return;
  player = document.createElement('audio');
  player.setAttribute('playsinline', '');
  player.style.display = 'none';
  document.body.appendChild(player);
  // Keep the playback control's play/pause label in sync with what the element is
  // actually doing (play() resolves after setActivePlayback, so the first state is
  // otherwise stale).
  for (const ev of ['play', 'playing', 'pause']) player.addEventListener(ev, notifyPlayback);
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
    getDingCtx(); // resume the tone context on the same gesture so later dings sound
  };
  document.addEventListener('touchend', unlock, { once: true, passive: true });
  document.addEventListener('click', unlock, { once: true });
}

// --- UI feedback tones (synthesized, no asset files) --------------------------
// Short cues so a send/reply is felt, not just seen. Independent of the spoken-
// reply mute — this is interface feedback the user asked for, not TTS readback.
let dingCtx = null;
function getDingCtx() {
  try {
    if (!dingCtx) dingCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (dingCtx.state === 'suspended') dingCtx.resume().catch(() => {});
    return dingCtx;
  } catch {
    return null;
  }
}

// kind: 'sent' (one blip) | 'success' (two rising) | 'error' (two falling, low).
const DING_SEQ = {
  sent: [[620, 0, 0.12]],
  success: [[660, 0, 0.1], [990, 0.1, 0.16]],
  error: [[400, 0, 0.14], [300, 0.15, 0.24]],
};
export function ding(kind = 'success') {
  const ctx = getDingCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [freq, at, dur] of DING_SEQ[kind] || DING_SEQ.success) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + at;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

export function playUrl(u) {
  return new Promise((resolve) => {
    try {
      player.src = u;
      const finish = () => {
        player.onended = null;
        clearActivePlayback(handle);
        resolve();
      };
      const handle = {
        pause: () => player.pause(),
        resume: () => { const p = player.play(); if (p && p.catch) p.catch(() => {}); },
        stop: () => { player.pause(); finish(); },
        isPaused: () => player.paused,
      };
      player.onended = finish;
      setActivePlayback(handle);
      const p = player.play();
      if (p && p.catch) p.catch(finish);
    } catch {
      resolve();
    }
  });
}

// Cut playback short — used by hands-free barge-in when you talk over a reply.
// Resolves whatever promise playUrl() handed out, so the caller's turn loop
// carries on rather than waiting for audio that will never finish.
export function stopAudio() {
  try {
    if (!player) return;
    player.pause();
    const done = player.onended;
    player.onended = null;
    player.removeAttribute('src');
    player.load();
    if (done) done();
  } catch {
    /* nothing playing */
  }
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
