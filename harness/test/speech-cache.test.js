// The point of the keyed speech cache: replaying something already spoken must
// not summarize or synthesize again. A hit therefore has to come back as a file
// path WITHOUT the text builder (which is where the summary model is called)
// running at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-speech-'));

const db = (await import('../src/db.js')).default;
const { AUDIO_DIR } = await import('../src/db.js');
const { streamSpeech, speechKey } = await import('../src/services/ttsCache.js');

const audio = join(AUDIO_DIR, 'cached.mp3');
writeFileSync(audio, 'not really an mp3');

test('a reply that has been spoken before replays without re-summarizing', async () => {
  const key = speechKey('reply', 'summary', 'the original claude reply');
  db.prepare('INSERT INTO speech_cache (key, spoken_text, audio_path) VALUES (?, ?, ?)').run(
    key,
    'the spoken wording',
    audio
  );

  let built = 0;
  const out = await streamSpeech(key, () => {
    built += 1;
    return 'a different summary';
  });

  assert.equal(built, 0, 'the summary builder must not run on a cache hit');
  assert.equal(out.path, audio);
  assert.equal(out.text, 'the spoken wording', 'the replay is the same wording as before');
});

test('the key follows the source text and the mode', () => {
  const a = speechKey('reply', 'summary', 'one reply');
  assert.equal(a, speechKey('reply', 'summary', 'one reply'));
  assert.notEqual(a, speechKey('reply', 'summary', 'another reply'));
  assert.notEqual(a, speechKey('reply', 'full', 'one reply'), 'full and summary are separate recordings');
});

test('a missing audio file falls back to rendering rather than a broken replay', async () => {
  const key = speechKey('reply', 'summary', 'reply whose audio was deleted');
  db.prepare('INSERT INTO speech_cache (key, spoken_text, audio_path) VALUES (?, ?, ?)').run(
    key,
    'gone',
    join(AUDIO_DIR, 'deleted.mp3')
  );

  let built = 0;
  await streamSpeech(key, () => {
    built += 1;
    return ''; // empty -> no synthesis, so the test stays offline
  }).catch(() => {});

  assert.equal(built, 1, 'the builder runs again when the cached file is gone');
});
