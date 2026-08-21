import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-tts-'));
// Blank, not absent: config falls back to env vars and dotenv loads the real
// .env, so a machine with a working key would otherwise make this suite call the
// live API. dotenv leaves an already-set variable alone, so this wins.
process.env.SPEECHMATICS_API_KEY = '';
const { providers, audioFormat } = await import('../src/services/tts/index.js');

// Every provider is interchangeable behind one contract — the facade calls these
// by name, so a provider missing one fails only at the moment someone speaks.
test('each provider implements the whole contract', () => {
  for (const [name, provider] of Object.entries(providers)) {
    for (const fn of ['isConfigured', 'getVoiceId', 'synthesize', 'synthesizeStream', 'listVoices']) {
      assert.equal(typeof provider[fn], 'function', `${name} is missing ${fn}()`);
    }
    assert.equal(typeof provider.label, 'string', `${name} has no label`);
  }
});

// Speechmatics returns WAV only. Serving that as audio/mpeg, or caching it under
// an .mp3 name, is the silent failure this format plumbing exists to prevent.
test('the audio format follows the provider that spoke', () => {
  assert.deepEqual(audioFormat('speechmatics'), { ext: 'wav', mime: 'audio/wav' });
  assert.deepEqual(audioFormat('elevenlabs'), { ext: 'mp3', mime: 'audio/mpeg' });
  assert.deepEqual(audioFormat('deepgram'), { ext: 'mp3', mime: 'audio/mpeg' });
});

test('an unknown provider still yields a usable default', () => {
  assert.deepEqual(audioFormat('nope'), { ext: 'mp3', mime: 'audio/mpeg' });
});

test('Speechmatics offers its four English voices and defaults to one of them', async () => {
  const voices = await providers.speechmatics.listVoices();
  assert.deepEqual(voices.map((v) => v.voice_id), ['sarah', 'theo', 'megan', 'jack']);
  // Same {voice_id, name, category} shape the other providers return, so the
  // Settings picker needs no per-engine special case.
  assert.ok(voices.every((v) => v.name && /English \((UK|US)\)/.test(v.category)));
  // No key configured in this temp data dir, so the default voice must still hold.
  assert.equal(providers.speechmatics.getVoiceId(), 'sarah');
  assert.equal(providers.speechmatics.isConfigured(), false);
});

test('speaking without a key fails before any request is made', async () => {
  await assert.rejects(
    () => providers.speechmatics.synthesize('hello'),
    /API key not configured/
  );
});
