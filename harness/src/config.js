// Config load/save over the SQLite `config` table, with env fallback so the
// harness can run headless (curl/CI) before the desktop wizard has written keys.
// First-run detection = the required keys are not all present.

import db from './db.js';

const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO config(key, value) VALUES(?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const delStmt = db.prepare('DELETE FROM config WHERE key = ?');
const allStmt = db.prepare('SELECT key, value FROM config');

// Config keys that may also be supplied via environment variable (env wins only
// when the DB value is absent). Keeps secrets out of the repo during testing.
const ENV_FALLBACK = {
  deepgram_api_key: 'DEEPGRAM_API_KEY',
  openai_api_key: 'OPENAI_API_KEY', // optional — dictation cleanup only (refine.js)
  elevenlabs_api_key: 'ELEVENLABS_API_KEY',
  elevenlabs_voice_id: 'ELEVENLABS_VOICE_ID',
  pairing_token: 'PAIRING_TOKEN',
  port: 'PORT',
};

export function getConfig(key, fallback = null) {
  const row = getStmt.get(key);
  if (row) return row.value;
  const envName = ENV_FALLBACK[key];
  if (envName && process.env[envName]) return process.env[envName];
  return fallback;
}

export function setConfig(key, value) {
  setStmt.run(key, String(value));
  return value;
}

export function deleteConfig(key) {
  delStmt.run(key);
}

export function getAllConfig() {
  const out = {};
  for (const { key, value } of allStmt.all()) out[key] = value;
  return out;
}

// The keys the harness always needs. Deepgram powers STT; `openai_api_key` is
// optional (dictation cleanup only) so it is not gated here.
export const REQUIRED_KEYS = ['deepgram_api_key', 'pairing_token'];

// TTS needs exactly one working provider — ElevenLabs is no longer mandatory.
// Deepgram (Aura-2) reuses the STT key and has a default voice, so this is
// satisfied the moment the Deepgram key exists; an install that explicitly picks
// ElevenLabs must supply its key *and* a voice.
export function isTtsReady() {
  const hasDeepgram = !!getConfig('deepgram_api_key');
  const hasEleven = !!getConfig('elevenlabs_api_key') && !!getConfig('elevenlabs_voice_id');
  const provider = getConfig('tts_provider');
  if (provider === 'elevenlabs') return hasEleven;
  if (provider === 'deepgram') return hasDeepgram;
  return hasEleven || hasDeepgram;
}

export function isFirstRun() {
  return REQUIRED_KEYS.some((k) => !getConfig(k)) || !isTtsReady();
}
