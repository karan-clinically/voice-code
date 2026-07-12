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
  constructor({ onState, onLevel, onUser, onAssistant, onError, transcribe, send }) {
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onUser = onUser || (() => {});
    this.onAssistant = onAssistant || (() => {});
    this.onError = onError || (() => {});
    this.transcribe = transcribe; // async (blob, ext) -> text
    this.send = send; // async (text) -> { text, audioUrl }
    this.on = false;
    this.state = 'idle';
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
    stopAudio();
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

      const reply = await this.send(said); // auto-sends — the point of this mode
      if (!this.on) return;
      if (reply?.text) this.onAssistant(reply.text);
      if (reply?.audioUrl) await this.speak(reply.audioUrl);
    } catch (e) {
      if (!this.on) return;
      this.onError(e.message);
    }
    if (this.on) this.listen();
  }

  // Play the reply, watching for barge-in the whole time.
  async speak(url) {
    this.setState('speaking');
    const playing = playUrl(url);
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
            stopAudio(); // you talked over it — cut the reply
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
