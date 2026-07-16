// Claude Code has no query API for "what model is this session on" — the CLI's
// `/model <alias>` sets it and prints a confirmation line, but there's no
// `claude config get model`. This module supplies both ends of that gap:
// a best-effort initial guess from settings.json (read once at session spawn)
// and the alias/label table sessionManager needs to parse the confirmation
// line and validate a switch request.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Aliases Claude Code's `/model <alias>` accepts non-interactively, in the
// order offered in the dropdown.
export const MODEL_OPTIONS = [
  { alias: 'default', label: 'Default' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'haiku', label: 'Haiku' },
  { alias: 'fable', label: 'Fable' },
  { alias: 'opusplan', label: 'Opus Plan' },
];

// Full model ids -> the friendly label Claude Code's confirmation text (or a
// settings.json `model` value) resolves to.
const KNOWN_MODELS = {
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-fable-5': 'Fable 5',
};

export function friendlyModelName(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  return KNOWN_MODELS[s] || MODEL_OPTIONS.find((m) => m.alias === s)?.label || s;
}

function readModelKey(path) {
  try {
    if (!existsSync(path)) return null;
    const json = JSON.parse(readFileSync(path, 'utf8'));
    return typeof json?.model === 'string' ? json.model : null;
  } catch {
    return null;
  }
}

// Settings precedence Claude Code itself uses: project-local, project, user.
// Purely a first guess for display — the confirmation-line scan in
// sessionManager.js is what keeps it accurate once the session is running.
export function guessInitialModel(cwd) {
  const raw =
    readModelKey(join(cwd, '.claude', 'settings.local.json')) ||
    readModelKey(join(cwd, '.claude', 'settings.json')) ||
    readModelKey(join(homedir(), '.claude', 'settings.json'));
  return friendlyModelName(raw) || 'Default';
}
