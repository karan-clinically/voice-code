// Harness REST client. On the Tailscale-serve HTTPS URL the harness sees
// localhost and skips auth; on plain HTTP a token comes in via the URL hash.

const base = location.origin;
const hp = new URLSearchParams(location.hash.slice(1));
if (hp.get('t')) {
  localStorage.setItem('cvh_token', hp.get('t'));
  history.replaceState(null, '', location.pathname);
}
const token = localStorage.getItem('cvh_token') || '';
const authQS = token ? 'token=' + encodeURIComponent(token) : '';
const H = token ? { Authorization: 'Bearer ' + token } : {};

async function parse(r) {
  const t = await r.text();
  let d = {};
  if (t) {
    try {
      d = JSON.parse(t);
    } catch {
      d = {};
    }
  }
  if (!r.ok) {
    throw new Error(
      d.error ||
        (r.status === 502 || r.status === 503 ? 'Harness offline — is it running on the PC?' : 'HTTP ' + r.status)
    );
  }
  return d;
}

export const apiBase = () => base;
export const authHeaders = () => H;
// The service worker can't read localStorage, so it's handed this on load — it needs
// it to answer a prompt (POST /select) straight from a notification button.
export const authToken = () => token;
// A hung fetch (mid network handoff, dead route) never rejects on its own, so a
// caller with a busy-guard around it — the Terminal screen poll is the case that
// bit us — stays stuck until something else resets the guard. Callers that poll
// on a fixed interval pass timeoutMs so a stall fails fast and the next tick can
// recover; long-running calls (e.g. commandText, which can legitimately wait
// minutes for a Claude turn) leave it unset and get no abort.
async function fetchTimeout(url, opts, timeoutMs) {
  if (!timeoutMs) return fetch(url, opts);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
export const jget = async (p, { timeoutMs } = {}) => parse(await fetchTimeout(base + p, { headers: H }, timeoutMs));
export const jpost = async (p, b) =>
  parse(await fetch(base + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }));
export const jform = async (p, fd) => parse(await fetch(base + p, { method: 'POST', headers: H, body: fd }));
export const jdelete = async (p) => parse(await fetch(base + p, { method: 'DELETE', headers: H }));
export const mediaUrl = (u) => base + u + (authQS ? (u.includes('?') ? '&' : '?') + authQS : '');
// Raw terminal WebSocket — lets the phone send raw keys (Enter, arrows, Esc,
// Space) to answer the TUI's interactive prompts, like the desktop terminal does.
export const termWsUrl = (id) =>
  base.replace(/^http/, 'ws') + `/ws/term?session=${id}` + (authQS ? '&' + authQS : '');

export const listSessions = () => jget('/api/sessions', { timeoutMs: 8000 });
export const listProviders = () => jget('/api/providers');
// Recent sessions for the Sessions tab: { harness: [...], remote: [...] } — the
// harness-spawned ones (live + recently ended) and external Claude sessions
// started in another terminal (driven from claude.ai remote control).
export const recentSessions = () => jget('/api/sessions/recent', { timeoutMs: 8000 });
export const reindexArchive = () => jpost('/api/archive/reindex');
export const createSession = (body) => jpost('/api/sessions', body);
// Open Claude's background-agent view in a pty so the phone can attach to / peek a
// live background agent (those reject --resume). cwd is where the view spawns.
export const openAgentView = (cwd, label) => jpost('/api/sessions/agent-view', { cwd, label });
// Resume a saved Grok conversation into a fresh PTY that reloads its context (cwd
// comes from the saved conversation server-side).
export const resumeGrok = (id) => jpost('/api/sessions', { kind: 'grok', resumeGrok: id });
// Forget a saved Grok conversation (deletes its context file). Only for `grok-saved`
// rows — there's no process to kill, so this is the only way to clear one.
export const deleteGrokConv = (id) => jdelete(`/api/sessions/grok/${id}`);
export const sessionInfo = (id) => jget(`/api/sessions/${id}`, { timeoutMs: 8000 });
export const killSession = (id) => jpost(`/api/sessions/${id}/kill`);
export const killLocal = (pid) => jpost('/api/sessions/kill-local', { pid });
export const muteSession = (id, muted) => jpost(`/api/sessions/${id}/mute`, { muted });
export const sessionScreen = (id) => jget(`/api/sessions/${id}/screen?full=1&color=1`, { timeoutMs: 8000 });
export const sessionScreenPlain = (id) => jget(`/api/sessions/${id}/screen?full=1`, { timeoutMs: 8000 });
export const sessionInput = (id, text) => jpost(`/api/sessions/${id}/input`, { text });
export const sessionResize = (id, cols, rows) => jpost(`/api/sessions/${id}/resize`, { cols, rows });
export const launchClaudeIn = (id) => jpost(`/api/sessions/${id}/launch-claude`);
export const launchGrokIn = (id) => jpost(`/api/sessions/${id}/launch-grok`);
export const launchCodexIn = (id) => jpost(`/api/sessions/${id}/launch-codex`);
export const launchProviderIn = (id, providerId) => jpost(`/api/sessions/${id}/launch-provider`, { providerId });
export const fsList = (path) => jget('/api/fs/list' + (path ? '?path=' + encodeURIComponent(path) : ''));
// cleanup=true runs the Wispr-style dictation pass server-side (fillers, false
// starts, phrasing) so the phone gets the same tidied text the desktop does — it
// never asked for it before, which is why phone dictation read as raw ASR.
export const transcribe = async (blob, ext, { cleanup = true } = {}) => {
  const fd = new FormData();
  fd.append('audio', blob, 'clip.' + ext);
  fd.append('cleanup', String(cleanup));
  return (await jform('/api/transcribe', fd)).text || '';
};
// desktopPlayback:false — the phone plays the reply itself, so skip the harness
// machine's blocking full-render and let Aura-2 stream to the phone (fast start).
export const commandText = (sessionId, text, timeoutMs) =>
  jpost('/api/command', { sessionId, text, desktopPlayback: false, ...(timeoutMs ? { timeoutMs } : {}) });

// --- settings ---
// Normal prefs are readable. API-key endpoints only expose has-key flags and write
// new values; they never return secret values to the phone/PWA.
export const getSettings = () => jget('/api/settings');
export const saveSettings = (patch) => jpost('/api/settings', patch);
export const apiKeyState = () => jget('/api/settings/keys');
export const saveApiKeys = (patch) => jpost('/api/settings/keys', patch);
// ElevenLabs voices for the Settings voice dropdown (non-secret metadata only).
export const listElevenVoices = () => jget('/api/settings/voices');

// --- push notifications (PWA) ---
export const pushVapid = () => jget('/api/push/vapid');
export const pushSubscribe = (subscription) => jpost('/api/push/subscribe', { subscription });
export const pushUnsubscribe = (endpoint) => jpost('/api/push/unsubscribe', { endpoint });
export const pushTest = () => jpost('/api/push/test');

// Shared batch|stream dictation mode, persisted harness-side so it survives
// app restarts and is the same setting the desktop sees.
export const getSttMode = async () => (await getSettings()).stt_mode || 'batch';
export const setSttMode = (mode) => saveSettings({ stt_mode: mode });
export const sttWsUrl = (lang) => {
  const qs = new URLSearchParams();
  if (lang) qs.set('lang', lang);
  if (token) qs.set('token', token);
  const q = qs.toString();
  return base.replace(/^http/, 'ws') + '/ws/stt' + (q ? '?' + q : '');
};

// --- session archive (past transcripts) ---
export const searchArchive = (q = '', project = '') =>
  jget('/api/archive?' + new URLSearchParams({ q, ...(project ? { project } : {}) }).toString());
export const archiveProjects = () => jget('/api/archive/projects');
export const resumeArchive = (uuid) => jpost(`/api/archive/${encodeURIComponent(uuid)}/resume`);

// --- chat view (conversation log) ---
export const sessionMessages = (id, after = 0) => jget(`/api/sessions/${id}/messages?after=${after}`);
export const sendChat = (id, text) => jpost(`/api/sessions/${id}/chat`, { text });

// --- spend tally: estimated API cost across providers ---
export const usageSummary = () => jget('/api/usage/summary');

// --- chat composer controls ---
export const sessionMode = (id) => jget(`/api/sessions/${id}/mode`);
export const sessionKey = (id, key) => jpost(`/api/sessions/${id}/key`, { key });
// Raw sequence over HTTP — the key channel's fallback when its WS is down, so a
// prompt answer typed right after a harness restart isn't silently lost.
export const sessionKeySeq = (id, seq) => jpost(`/api/sessions/${id}/key`, { seq });

// --- interactive picker (question + numbered options Claude is waiting on) ---
export const sessionPrompt = (id) => jget(`/api/sessions/${id}/prompt`, { timeoutMs: 8000 });
// Answer option `index`; resolves with Claude's follow-up reply ({responseText, audioUrl, prompt}).
export const selectPromptOption = (id, index) => jpost(`/api/sessions/${id}/select`, { index, desktopPlayback: false });
export const attachFile = (id, file) => {
  const fd = new FormData();
  fd.append('file', file, file.name || 'upload');
  return jform(`/api/sessions/${id}/attach`, fd);
};
export const listPrompts = () => jget('/api/prompts');
export const savePrompt = (text, label) => jpost('/api/prompts', { text, label });
export const deletePrompt = (id) => jdelete(`/api/prompts/${id}`);

// Speak arbitrary text. Returns a URL for the <audio> element to fetch itself, so
// playback starts on the first mp3 frames (~300ms) rather than after the full
// render — buffering it into a Blob first would throw that streaming away.
export function sayUrl(text, voiceId) {
  const qs = new URLSearchParams({ text });
  if (voiceId) qs.set('voiceId', voiceId);
  if (token) qs.set('token', token);
  return base + '/api/tts/say?' + qs.toString();
}

// Speak this session's latest Claude reply: 'summary' (the short spoken version)
// or 'full' (the whole answer, verbatim). The harness holds the text, so nothing
// travels up the URL — which is what used to blow /say's length cap on long
// replies and read the markdown symbols aloud.
export function replyUrl(sessionId, mode = 'summary') {
  const qs = new URLSearchParams({ mode });
  if (token) qs.set('token', token);
  return base + `/api/tts/reply/${sessionId}?` + qs.toString();
}
