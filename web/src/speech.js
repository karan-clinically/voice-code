// Spoken-reply helper. The agent is instructed (api/_lib/agent.js) to end each
// turn with a short read-aloud summary, so for long replies speaking the tail
// captures it; short replies are spoken whole.

import { ttsUrl } from './api.js';

const MAX_SPOKEN = 700;

export function speakableText(text) {
  const t = (text || '').replace(/```[\s\S]*?```/g, ' (code omitted) ').trim();
  if (t.length <= MAX_SPOKEN) return t;
  const paras = t.split(/\n\s*\n/).filter(Boolean);
  let out = '';
  for (let i = paras.length - 1; i >= 0; i--) {
    const candidate = paras[i] + (out ? '\n\n' + out : '');
    if (candidate.length > MAX_SPOKEN) break;
    out = candidate;
  }
  return out || t.slice(-MAX_SPOKEN);
}

let current = null;

export function speak(text) {
  const t = speakableText(text);
  if (!t) return null;
  stopSpeaking();
  const audio = new Audio(ttsUrl(t));
  current = audio;
  audio.play().catch(() => { /* autoplay blocked until first user gesture */ });
  return audio;
}

export function stopSpeaking() {
  if (current) {
    try { current.pause(); } catch { /* noop */ }
    current = null;
  }
}
