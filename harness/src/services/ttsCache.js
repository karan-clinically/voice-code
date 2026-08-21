// Audio for a recorded interaction, synthesized lazily and exactly once.
//
// Why lazy: synthesis is the slowest step in a turn (a full Aura-2 render takes
// ~2s). Blocking the command response on it delayed everything. Instead the reply
// is stored with audio_path NULL and the client is handed /api/tts/<id>; the first
// listener triggers synthesis and receives the mp3 frames as they arrive (~400ms
// to first sound instead of ~2000ms). The bytes are tee'd into the audio cache on
// the way past, so replays are a plain file send and cost nothing further.

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import db from '../db.js';
import { synthesizeStream, activeProviderName, getVoiceId } from './tts/index.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('ttsCache');
const sel = db.prepare('SELECT summary, audio_path FROM interactions WHERE id = ?');
const upd = db.prepare('UPDATE interactions SET audio_path = ?, tts_chars = ? WHERE id = ?');

// interactionId -> Promise<{path,...}> for a render currently in progress.
const inflight = new Map();

function lookup(id) {
  const row = sel.get(id);
  if (!row) return { missing: true };
  if (row.audio_path && existsSync(row.audio_path)) return { path: row.audio_path };
  if (!row.summary) return { empty: true };
  return { summary: row.summary };
}

// Kick off a render and register it in the in-flight map SYNCHRONOUSLY — before
// the first await. Registering after `await synthesizeStream(...)` would let two
// concurrent listeners both slip past the check and synthesize (and bill) twice.
// The audio stream itself is handed back through a deferred.
function beginRender(id, summary) {
  let resolveStream;
  let rejectStream;
  const streamReady = new Promise((res, rej) => {
    resolveStream = res;
    rejectStream = rej;
  });

  const settled = (async () => {
    let stream;
    let done;
    let mime;
    try {
      ({ stream, done, mime } = await synthesizeStream(summary));
    } catch (err) {
      rejectStream(err);
      throw err;
    }
    resolveStream({ stream, mime });
    const audio = await done;
    upd.run(audio.path, audio.chars, id);
    log.info(`cached tts for interaction ${id}: ${audio.provider}/${audio.voiceId}, ${audio.chars} chars`);
    return audio;
  })().finally(() => inflight.delete(id));

  inflight.set(id, settled);
  settled.catch(() => {}); // the caller surfaces the error; don't crash on unhandled
  return { streamReady, settled };
}

// Progressive: { stream, done } on a cache miss, { path } on a hit (or when
// another listener is already rendering — wait for them rather than pay twice).
export async function streamAudio(id) {
  const found = lookup(id);
  if (found.missing || found.empty || found.path) return found;
  if (inflight.has(id)) return { path: (await inflight.get(id)).path };

  const { streamReady, settled } = beginRender(id, found.summary);
  const ready = await streamReady;
  return { stream: ready.stream, mime: ready.mime, done: settled };
}

// Blocking: resolve to a complete file on disk — the local PowerShell player needs
// a path, not a pipe. Shares the in-flight map with streamAudio().
export async function ensureAudio(id) {
  const found = lookup(id);
  if (found.missing || found.empty) return found;
  if (found.path) return found;
  if (inflight.has(id)) return { path: (await inflight.get(id)).path };

  const { streamReady, settled } = beginRender(id, found.summary);
  // Nobody is reading the listener branch here; drop it so the tee isn't holding
  // bytes for a reader that will never arrive. The cache branch still completes.
  streamReady.then((s) => s.cancel().catch(() => {})).catch(() => {});
  return { path: (await settled).path };
}

// --- keyed speech cache -------------------------------------------------------
// The same idea for speech that isn't tied to an interaction row: the spoken reply
// behind the phone's 🔊 button, and one-off /say lines. Keyed on the SOURCE text
// (plus the voice), which is known before any work happens — so a replay skips the
// summary model as well as the TTS provider. Without this, every tap re-summarized
// (a fresh, differently-worded summary each time) and re-synthesized, billing both.

const selKey = db.prepare('SELECT spoken_text, audio_path FROM speech_cache WHERE key = ?');
const insKey = db.prepare(
  'INSERT OR REPLACE INTO speech_cache (key, spoken_text, audio_path) VALUES (?, ?, ?)'
);

const inflightKeys = new Map(); // key -> Promise<audio>

// Include the voice: switching voices should re-render rather than replay the old one.
export function speechKey(...parts) {
  const h = createHash('sha1');
  for (const p of [activeProviderName(), getVoiceId() || '', ...parts]) h.update(String(p) + '\u0000');
  return h.digest('hex');
}

// Same synchronous-registration rule as beginRender above: two taps that land
// together must not both summarize and both synthesize.
function beginKeyedRender(key, makeText, opts) {
  let resolveStream;
  let rejectStream;
  const streamReady = new Promise((res, rej) => {
    resolveStream = res;
    rejectStream = rej;
  });

  const settled = (async () => {
    let stream;
    let done;
    let mime;
    try {
      const text = String((await makeText()) || '').trim();
      if (!text) {
        const err = new Error('nothing to speak');
        err.empty = true;
        throw err;
      }
      ({ stream, done, mime } = await synthesizeStream(text, opts));
      resolveStream({ stream, mime });
      const audio = await done;
      insKey.run(key, text, audio.path);
      log.info(`cached speech ${key.slice(0, 8)}: ${audio.provider}/${audio.voiceId}, ${audio.chars} chars`);
      return audio;
    } catch (err) {
      rejectStream(err);
      throw err;
    }
  })().finally(() => inflightKeys.delete(key));

  inflightKeys.set(key, settled);
  settled.catch(() => {}); // the caller surfaces the error; don't crash on unhandled
  return { streamReady, settled };
}

// { path } when it has been spoken before (or is being rendered right now for
// another listener), { stream, done } on a miss. `makeText` is only called on a
// miss — that is where the summary spend is avoided.
export async function streamSpeech(key, makeText, opts = {}) {
  const row = selKey.get(key);
  if (row?.audio_path && existsSync(row.audio_path)) return { path: row.audio_path, text: row.spoken_text };
  if (inflightKeys.has(key)) return { path: (await inflightKeys.get(key)).path };

  const { streamReady, settled } = beginKeyedRender(key, makeText, opts);
  try {
    const ready = await streamReady;
    return { stream: ready.stream, mime: ready.mime, done: settled };
  } catch (err) {
    if (err?.empty) return { empty: true }; // nothing worth speaking — caller 404s
    throw err;
  }
}
