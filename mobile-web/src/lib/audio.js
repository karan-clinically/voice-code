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

// --- audio focus -------------------------------------------------------------
// Android hands the speaker to one app at a time and only lets the user's music
// resume once every producer in this tab goes quiet. Two things count as "still
// producing" even in silence: a media element that still has a source loaded,
// and an AudioContext in the `running` state. So after a spoken reply (or a UI
// ding, or a recording) we must actively release BOTH, or the car stays silent
// until the tab is closed — which is exactly the reported symptom.
//
// The release is debounced: back-to-back clips would otherwise make the stereo
// flap between Claude and the music between every sentence.
let releaseTimer = null;

// Chrome keeps its OS media session (the entry a car dashboard shows) alive
// after a clip ENDS, deliberately, so the user can replay it — and while that
// entry exists the car treats us as the current source and never resumes the
// music. Emptying the element is not enough; the element itself has to go, and
// the session's metadata/handlers have to be cleared. Both are cheap: playUrl
// builds a fresh element on demand.
const MEDIA_SESSION_ACTIONS = [
  'play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto',
  'previoustrack', 'nexttrack',
];

function clearMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try { ms.playbackState = 'none'; } catch { /* unsupported */ }
  try { ms.metadata = null; } catch { /* unsupported */ }
  for (const action of MEDIA_SESSION_ACTIONS) {
    try { ms.setActionHandler(action, null); } catch { /* action unsupported here */ }
  }
}

function destroyPlayer() {
  if (!player) return;
  try {
    player.pause();
    player.removeAttribute('src');
    player.load(); // -> NETWORK_EMPTY: the element no longer owns a resource
    player.remove();
  } catch {
    /* already gone */
  }
  player = null;
}

function releaseNow() {
  releaseTimer = null;
  // A registered handle means something is genuinely mid-playback (or paused
  // awaiting the user's Resume) — keep the source loaded so Resume still works.
  // `active` means something is genuinely mid-playback (or paused awaiting the
  // user's Resume) — suspending the context would freeze it mid-sentence.
  if (!active) {
    destroyPlayer();
    try {
      if (dingCtx && dingCtx.state === 'running') dingCtx.suspend().catch(() => {});
    } catch {
      /* context already gone */
    }
  }
  clearMediaSession();
}

// Give the speaker back to whatever was playing before (music, podcast, nav).
export function releaseAudioFocusSoon(delayMs = 700) {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseNow, delayMs);
}

// Cancel a pending release — we're about to make sound again.
export function holdAudioFocus() {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  try {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
  } catch {
    /* unsupported */
  }
}

// The element is rebuilt on demand because releasing the speaker destroys it
// (see destroyPlayer). Autoplay stays permitted: Chrome's gate is the page's
// sticky user activation, which the unlock gesture below grants for the page's
// lifetime, not a property of any one element.
function ensurePlayer() {
  if (player) return player;
  player = document.createElement('audio');
  player.setAttribute('playsinline', '');
  player.style.display = 'none';
  document.body.appendChild(player);
  // Keep the playback control's play/pause label in sync with what the element is
  // actually doing (play() resolves after setActivePlayback, so the first state is
  // otherwise stale).
  for (const ev of ['play', 'playing', 'pause']) player.addEventListener(ev, notifyPlayback);
  return player;
}

export function initAudio() {
  if (player) return;
  ensurePlayer();
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    try {
      const el = ensurePlayer();
      el.src = SILENT;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* ignore */
    }
    getDingCtx(); // resume the tone context on the same gesture so later dings sound
    // Unlocking is silent, but both claims above still take the speaker from the
    // user's music. Hand it straight back — we only need the permission, not the
    // channel, until there's actually something to say.
    releaseAudioFocusSoon(400);
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
  holdAudioFocus();
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
  releaseAudioFocusSoon(); // a cue is a blip, not a reason to hold the speaker
}

// Spoken replies play through Web Audio, NOT the <audio> element, and this is
// load-bearing on Android: Chrome asks the OS for *permanent* audio focus on
// behalf of a media element, which tells Spotify "stop for good" — it then stays
// paused however cleanly we release afterwards. A pure Web Audio source is
// registered as a one-shot/ambient player instead, which takes focus only
// transiently, so the car ducks the music under Claude and restores it after.
// (It also keeps us off the car's now-playing slot entirely.)
//
// Cost: the whole clip must download and decode before playback starts, so this
// falls back to the streaming element path whenever fetch/decode can't deliver.
let voiceSource = null;

// Android mixes a transient sound in rather than ducking the music app, and a web
// page cannot turn Spotify down. What it CAN do is come through clearly over the
// top — the way a navigation prompt does. Boost is per-device (a car needs far
// more than headphones) and compressed rather than clipped, so raising it stays
// intelligible instead of turning harsh.
const VOICE_BOOST_KEY = 'cvh-voice-boost';
export const VOICE_BOOST_LEVELS = [
  { id: 'off', label: 'Normal', gain: 1 },
  { id: 'loud', label: 'Loud', gain: 2.2 },
  { id: 'car', label: 'Car', gain: 3.6 },
];

export function voiceBoost() {
  try {
    const saved = localStorage.getItem(VOICE_BOOST_KEY);
    return VOICE_BOOST_LEVELS.find((l) => l.id === saved) || VOICE_BOOST_LEVELS[0];
  } catch {
    return VOICE_BOOST_LEVELS[0];
  }
}

export function setVoiceBoost(id) {
  try { localStorage.setItem(VOICE_BOOST_KEY, id); } catch { /* private mode */ }
}

// source -> gain -> compressor -> speaker. The compressor is what makes a 3.6x
// boost usable: it holds the peaks instead of letting them clip.
function voiceChain(ctx) {
  const gain = ctx.createGain();
  gain.gain.value = voiceBoost().gain;
  let tail = gain;
  try {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    gain.connect(comp);
    tail = comp;
  } catch {
    /* no compressor here — plain gain still works */
  }
  tail.connect(ctx.destination);
  return gain;
}

function stopVoiceSource() {
  if (!voiceSource) return;
  try { voiceSource.stop(); } catch { /* already ended */ }
  voiceSource = null;
}

async function playViaWebAudio(url, onStart) {
  holdAudioFocus(); // a release armed by an earlier ding must not suspend us mid-reply
  const ctx = getDingCtx();
  if (!ctx || !window.fetch) return false;
  let buffer;
  try {
    const res = await fetch(url);
    // A refused synthesis answers with JSON, not audio — and the <audio> fallback
    // would fail on it just as silently, which is how a dead TTS key looked like
    // "the speaker button does nothing". Carry the server's reason out instead.
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try { reason = (await res.json())?.error || reason; } catch { /* not JSON */ }
      throw Object.assign(new Error(reason), { unplayable: true });
    }
    buffer = await ctx.decodeAudioData(await res.arrayBuffer());
  } catch (err) {
    if (err?.unplayable) throw err;
    return false; // unfetchable or undecodable — caller falls back to the element
  }
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* gesture-gated; fall through */ }
  }
  return new Promise((resolve) => {
    let src;
    try {
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(voiceChain(ctx));
    } catch {
      return resolve(false);
    }
    stopVoiceSource();
    voiceSource = src;
    const handle = {
      pause: () => { ctx.suspend().catch(() => {}); },
      resume: () => { ctx.resume().catch(() => {}); },
      stop: () => { ctx.resume().catch(() => {}); stopVoiceSource(); },
      isPaused: () => ctx.state === 'suspended',
    };
    src.onended = () => {
      if (voiceSource === src) voiceSource = null;
      clearActivePlayback(handle);
      releaseAudioFocusSoon(); // suspends the context -> focus returns to Spotify
      resolve(true);
    };
    setActivePlayback(handle);
    try {
      src.start();
      onStart?.();
    } catch {
      clearActivePlayback(handle);
      resolve(false);
    }
  });
}

// --- playback queue -----------------------------------------------------------
// Replies arrive faster than they can be spoken — a finished turn, a prompt to
// read out, a replay you asked for. Starting the new one used to cut the current
// one off mid-sentence, so the half you were listening to was simply lost. They
// queue instead: each clip waits for the one before it, and the returned promise
// still resolves when THIS clip has finished, so callers that await playback (the
// hands-free turn loop) are unaffected.
//
// stopAudio() is the deliberate interrupt — barge-in, or muting the speaker — and
// drops whatever is still waiting rather than letting it start after the silence.
let queueTail = Promise.resolve();
let queueEpoch = 0;

// `progressive`: start playing while the audio is still downloading, via the
// media element. Worth it for anything you asked for by tapping — the Web Audio
// path below must fetch and decode the WHOLE clip first, which on a megabyte of
// WAV over a phone link is fifteen seconds of silence and no visible sign that
// the tap did anything. It is NOT the default: element playback routes to the
// earpiece while the mic is capturing, which is why hands-free and automatic
// reply playback stay on Web Audio.
export function playUrl(u, { onStart, onError, progressive = false } = {}) {
  const epoch = queueEpoch;
  const run = queueTail.then(async () => {
    if (epoch !== queueEpoch) return undefined; // flushed while it waited its turn
    if (progressive) {
      const played = await playViaElement(u, { onStart });
      if (played !== false) return undefined;
      // Never started — fall through, where the fetch reports WHY.
    }
    return playViaWebAudio(u, onStart)
      .then((ok) => (ok ? undefined : playViaElement(u, { onStart })))
      .catch((err) => {
        // Nothing can play this: telling the caller beats silence. The element
        // fallback is skipped — it would choke on the same non-audio response.
        if (!err?.unplayable) throw err;
        onError?.(err.message);
      });
  });
  queueTail = run.catch(() => {}); // one clip failing must not stall the queue
  return run;
}

function flushQueue() {
  queueEpoch += 1;
  queueTail = Promise.resolve();
}

function playViaElement(u, { onStart } = {}) {
  return new Promise((resolve) => {
    try {
      holdAudioFocus();
      const player = ensurePlayer(); // released playback destroys the old element
      player.src = u;
      let settled = false;
      // `false` means it never made a sound, so a caller that tried this path
      // first can fall back and surface a real reason. Anything else — played to
      // the end, or paused awaiting a gesture — counts as handled.
      let started = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finish = (value) => {
        player.onended = null;
        player.onerror = null;
        clearActivePlayback(handle);
        releaseAudioFocusSoon(); // reply over — give the music back
        settle(value);
      };
      const handle = {
        pause: () => player.pause(),
        resume: () => { const p = player.play(); if (p && p.catch) p.catch(() => {}); },
        stop: () => { player.pause(); finish(true); },
        isPaused: () => player.paused,
      };
      player.onended = () => finish(true);
      // A source the element can't play (a JSON error body, an unsupported
      // codec) fails here before a single frame — report that as "not played".
      player.onerror = () => finish(started ? true : false);
      setActivePlayback(handle);
      const p = player.play();
      if (p && p.then) p.then(() => { started = true; onStart?.(); }).catch(() => {
        // Mobile browsers suspend autoplay while the page is backgrounded. Keep
        // the requested URL and playback handle intact so the visible Resume
        // button can continue this exact assistant clip on the next user gesture.
        // Resolving here avoids leaving callers hung while playback is paused.
        notifyPlayback();
        settle(true);
      });
      else { started = true; onStart?.(); }
    } catch {
      resolve(false);
    }
  });
}

// Cut playback short — used by hands-free barge-in when you talk over a reply.
// Resolves whatever promise playUrl() handed out, so the caller's turn loop
// carries on rather than waiting for audio that will never finish.
export function stopAudio() {
  flushQueue(); // an interrupt cancels what's waiting too, not just what's audible
  stopVoiceSource(); // Web Audio path (the normal one) — its onended releases focus
  try {
    if (!player) return;
    player.pause();
    const done = player.onended;
    player.onended = null;
    player.removeAttribute('src');
    player.load();
    if (done) done();
    releaseAudioFocusSoon(0); // barge-in: hand the speaker back immediately
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
    holdAudioFocus(); // capturing takes the channel; don't let a pending release race it
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    releaseAudioFocusSoon(0);
    onErr && onErr('Mic: ' + e.message);
    return null;
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    // Stopping the tracks is what actually frees the microphone — until then the
    // OS keeps the route in capture mode and the music stays paused.
    stream.getTracks().forEach((t) => t.stop());
    releaseAudioFocusSoon(0);
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
