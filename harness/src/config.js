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

// The keys the harness needs before it can run the full voice pipeline.
// Deepgram powers STT; `openai_api_key` is optional (dictation cleanup only) so
// it is not gated here.
export const REQUIRED_KEYS = [
  'deepgram_api_key',
  'elevenlabs_api_key',
  'elevenlabs_voice_id',
  'pairing_token',
];

export function isFirstRun() {
  return REQUIRED_KEYS.some((k) => !getConfig(k));
}
