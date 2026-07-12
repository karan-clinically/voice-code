// Hands-free conversation loop: listen -> think -> speak -> listen, with no
// buttons in between.
//
// DELIBERATE EXCEPTION to the review-before-send contract. Everywhere else a
// transcript lands in a box and only Send reaches the pty. Here, that IS the
// feature: you are driving by voice with your hands busy, so a turn auto-sends.
// It is opt-in, lives behind its own full-screen view, and nothing outside this
// mode auto-sends.
//
// Turn detection is RMS voice-activity: speech starts above SPEECH_RMS, and the
// turn ends after SILENCE_MS of quiet (so you can pause mid-sentence without it
// firing early).
//
// Barge-in: the mic and analyser stay live while the reply plays, so talking over
// Claude cuts the audio and starts capturing you. The speaker feeds back into the
// mic, so barge-in needs a HIGHER bar than normal speech (BARGE_RMS), must be
// sustained (BARGE_HOLD_MS), and is ignored for BARGE_GUARD_MS after playback
// starts — otherwise the reply's own first syllable interrupts itself. Browser
// echo cancellation does most of the work; these are the belt and braces.

import { pickMime, playUrl, stopAudio } from './audio.js';

// Spoken replies are summarized by default. These phrases mean "read out the
// reply you just summarized" — they are answered locally from the text the
// harness already has, instead of being sent to Claude as a new prompt.
//
// The guard against hijacking a genuine follow-up is the WHOLE-utterance match:
// "more detail" on its own replays the last reply, but "more detail on the rate
// limiter" is a real question and goes to Claude. Leading politeness and trailing
// "please" are stripped first so "can you read that in full please" still counts.
const READ_FULL = new Set([
  'read the full response', 'read the full reply', 'read the full answer',
  'read that in full', 'read it in full', 'read it out in full', 'read in full',
  'read it all', 'read it out', 'read the rest', 'read the whole thing',
  'say the whole thing', 'say it all',
  'full response', 'full reply', 'full answer', 'the full response', 'the whole thing',
  'tell me more', 'more detail', 'more details', 'give me more detail',
  'give me more details', 'expand on that', 'go on',
]);

export function isReadFullRequest(text) {
  const t = (text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:ok|okay|hey|claude|please|can you|could you|would you|just)\s+/g, '')
    .replace(/\s+please$/, '')
    .trim();
  return READ_FULL.has(t);
}

// When Claude is waiting on a numbered picker, map a spoken answer to an option
// number — "option two", "number 3", "the second one", or a bare "two". Returns
// null when nothing in [1..max] is named (so it isn't mistaken for a new question).
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
export function parseOptionNumber(text, max) {
  const t = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const ok = (n) => (n >= 1 && n <= max ? n : null);
  let m = t.match(/\b(?:option|number|choice|answer|pick|select)\s+(\d{1,2})\b/);
  if (m) return ok(+m[1]);
  m = t.match(/\b(?:option|number|choice|answer|pick|select)\s+([a-z]+)\b/);
  if (m && NUM_WORDS[m[1]] != null) return ok(NUM_WORDS[m[1]]);
  for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`).test(t)) return ok(n);
  if (/^\d{1,2}$/.test(t)) return ok(+t); // a bare "2"
  if (NUM_WORDS[t] != null) return ok(NUM_WORDS[t]); // a bare "two"
  return null;
}

const SPEECH_RMS = 0.03; // start-of-speech threshold while listening
const SILENCE_MS = 1200; // quiet needed to call the turn finished
const MIN_SPEECH_MS = 350; // ignore coughs/clicks
const MAX_TURN_MS = 60000; // hard stop on a runaway turn

const BARGE_RMS = 0.055; // louder than normal — the speaker is also in the room
const BARGE_HOLD_MS = 250; // must be sustained, not a transient
const BARGE_GUARD_MS = 700; // ignore the reply's own onset

const TICK_MS = 60;

export class HandsFree {
  // onState('listening'|'thinking'|'speaking'|'idle') · onLevel(0..1 for the orb)
  // onUser(text) · onAssistant(text) · onError(msg)
  constructor({ onState, onLevel, onUser, onAssistant, onError, onPrompt, transcribe, send, select, fullReplyUrl }) {
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onUser = onUser || (() => {});
    this.onAssistant = onAssistant || (() => {});
    this.onError = onError || (() => {});
    this.onPrompt = onPrompt || (() => {}); // (prompt|null) -> view renders option buttons
    this.transcribe = transcribe; // async (blob, ext) -> text
    this.send = send; // async (text) -> { text, audioUrl, prompt }
    this.select = select; // async (index) -> { text, audioUrl, prompt } (answers a picker)
    this.fullReplyUrl = fullReplyUrl; // () -> url that speaks the last reply in full
    this.hasReply = false; // nothing to read out in full until Claude has answered
    this.pendingPrompt = null; // the picker Claude is waiting on, if any
    this.on = false;
    this.state = 'idle';
  }

  // Read out the last reply verbatim. Also driven by the view's "Read in full"
  // button, so the voice trigger has a tappable equivalent.
  async speakFull() {
    if (!this.fullReplyUrl) return false;
    this.setState('speaking');
    try {
      await this.speak(this.fullReplyUrl());
      return true;
    } catch (e) {
      this.onError('Could not read the full reply: ' + e.message);
      return false;
    }
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.onError('Microphone unavailable: ' + e.message);
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.on = true;
    this.listen();
    return true;
  }

  stop() {
    this.on = false;
    clearTimeout(this.tid);
    this.stopPlayback();
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.analyser = null;
    this.setState('idle');
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = (this.buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.buf.length);
  }

  // Open the mic and wait for a turn.
  listen() {
    if (!this.on) return;
    this.setState('listening');
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.finishTurn();
    this.rec.start();
    this.speaking = false;
    this.silenceAt = 0;
    this.speechAt = 0;
    this.startedAt = performance.now();
    this.monitor();
  }

  monitor() {
    if (!this.on || this.state !== 'listening') return;
    const rms = this.level();
    this.onLevel(Math.min(1, rms / 0.25));
    const now = performance.now();

    if (rms > SPEECH_RMS) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechAt = now;
      }
      this.silenceAt = 0;
    } else if (this.speaking) {
      if (!this.silenceAt) this.silenceAt = now;
      else if (now - this.silenceAt > SILENCE_MS && now - this.speechAt > MIN_SPEECH_MS) {
        return this.endCapture();
      }
    }
    if (this.speaking && now - this.startedAt > MAX_TURN_MS) return this.endCapture();
    this.tid = setTimeout(() => this.monitor(), TICK_MS);
  }

  endCapture() {
    clearTimeout(this.tid);
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); // -> finishTurn()
    } catch {
      /* ignore */
    }
  }

  async finishTurn() {
    const chunks = this.chunks;
    this.chunks = [];
    if (!this.on) return;
    // Nothing but silence — reopen the mic without bothering Claude.
    if (!chunks.length || !this.speaking) return this.listen();

    const type = this.rec?.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';

    this.setState('thinking');
    this.onLevel(0);
    try {
      const said = (await this.transcribe(new Blob(chunks, { type }), ext)).trim();
      if (!said) return this.listen(); // heard noise, not words
      if (!this.on) return;
      this.onUser(said);

      // Claude is waiting on a picker — a spoken option number answers it (single-
      // select only; multi-question ones are answered in the terminal). Anything
      // that isn't an option number leaves the picker up rather than typing into it.
      if (this.pendingPrompt && !this.pendingPrompt.multi) {
        const n = parseOptionNumber(said, this.pendingPrompt.options.length);
        if (n != null) {
          await this.chooseOption(n);
          if (this.on) this.listen();
          return;
        }
        this.onError('Say an option number, or tap one.');
        if (this.on) this.listen();
        return;
      }

      // "read that in full" / "tell me more" — answer it here from the reply we
      // already have rather than bothering Claude for a fresh (and different) one.
      // Only once there IS a reply to read; otherwise it is just a normal prompt.
      if (this.hasReply && isReadFullRequest(said)) {
        await this.speakFull();
        if (this.on) this.listen();
        return;
      }

      const reply = await this.send(said); // auto-sends — the point of this mode
      if (!this.on) return;
      await this.applyReply(reply);
    } catch (e) {
      if (!this.on) return;
      this.onError(e.message);
    }
    if (this.on) this.listen();
  }

  // Show/speak a reply and surface any picker it ends on.
  async applyReply(reply) {
    if (reply?.text) {
      this.hasReply = true;
      this.onAssistant(reply.text);
    }
    this.pendingPrompt = reply?.prompt || null;
    this.onPrompt(this.pendingPrompt);
    if (reply?.audioUrl) await this.speak(reply.audioUrl);
  }

  // Answer the current picker (by voice number or a tapped button) and handle
  // whatever Claude does next — which may be another picker.
  async chooseOption(index) {
    if (!this.select) return;
    this.pendingPrompt = null;
    this.onPrompt(null);
    this.setState('thinking');
    this.onLevel(0);
    try {
      const reply = await this.select(index);
      if (!this.on) return;
      await this.applyReply(reply);
    } catch (e) {
      if (this.on) this.onError(e.message);
    }
  }

  // Play the reply through the SAME AudioContext the mic analyser uses (Web Audio),
  // not an <audio> element. On Android/iOS Chrome, element playback while
  // getUserMedia is capturing gets routed to the earpiece (the OS switches to
  // communication audio mode) and is inaudible on the loudspeaker; Web Audio output
  // stays on the media route. Falls back to the element if decode/playback fails.
  async playBuffer(url) {
    const ctx = this.ctx;
    if (!ctx) return playUrl(url);
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    let buf;
    try {
      const arr = await (await fetch(url)).arrayBuffer();
      buf = await ctx.decodeAudioData(arr);
    } catch {
      return playUrl(url); // fetch/decode failed — element fallback
    }
    if (!this.on) return undefined;
    return new Promise((resolve) => {
      let src;
      try {
        src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
      } catch {
        return resolve();
      }
      this.playNode = src;
      src.onended = () => {
        if (this.playNode === src) this.playNode = null;
        resolve();
      };
      try { src.start(); } catch { resolve(); }
    });
  }

  // Cut whatever is playing — the Web Audio source and, if the fallback was used,
  // the shared <audio> element.
  stopPlayback() {
    if (this.playNode) {
      try { this.playNode.stop(); } catch { /* already stopped */ }
      this.playNode = null;
    }
    stopAudio();
  }

  // Play the reply, watching for barge-in the whole time.
  async speak(url) {
    this.setState('speaking');
    const playing = this.playBuffer(url);
    const startedAt = performance.now();
    let loudSince = 0;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(this.tid);
        resolve();
      };
      playing.then(finish);

      const watch = () => {
        if (done || !this.on || this.state !== 'speaking') return finish();
        const now = performance.now();
        const rms = this.level();
        this.onLevel(Math.min(1, rms / 0.25));

        if (now - startedAt > BARGE_GUARD_MS && rms > BARGE_RMS) {
          if (!loudSince) loudSince = now;
          else if (now - loudSince > BARGE_HOLD_MS) {
            this.stopPlayback(); // you talked over it — cut the reply
            return finish();
          }
        } else {
          loudSince = 0;
        }
        this.tid = setTimeout(watch, TICK_MS);
      };
      watch();
    });
    this.onLevel(0);
  }
}
