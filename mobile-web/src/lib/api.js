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
export const jget = async (p) => parse(await fetch(base + p, { headers: H }));
export const jpost = async (p, b) =>
  parse(await fetch(base + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }));
export const jform = async (p, fd) => parse(await fetch(base + p, { method: 'POST', headers: H, body: fd }));
export const jdelete = async (p) => parse(await fetch(base + p, { method: 'DELETE', headers: H }));
export const mediaUrl = (u) => base + u + (authQS ? (u.includes('?') ? '&' : '?') + authQS : '');
// Raw terminal WebSocket — lets the phone send raw keys (Enter, arrows, Esc,
// Space) to answer the TUI's interactive prompts, like the desktop terminal does.
export const termWsUrl = (id) =>
  base.replace(/^http/, 'ws') + `/ws/term?session=${id}` + (authQS ? '&' + authQS : '');

export const listSessions = () => jget('/api/sessions');
export const createSession = (body) => jpost('/api/sessions', body);
export const killSession = (id) => jpost(`/api/sessions/${id}/kill`);
export const sessionScreen = (id) => jget(`/api/sessions/${id}/screen?full=1&color=1`);
export const sessionScreenPlain = (id) => jget(`/api/sessions/${id}/screen?full=1`);
export const sessionInput = (id, text) => jpost(`/api/sessions/${id}/input`, { text });
export const sessionResize = (id, cols, rows) => jpost(`/api/sessions/${id}/resize`, { cols, rows });
export const launchClaudeIn = (id) => jpost(`/api/sessions/${id}/launch-claude`);
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
export const commandText = (sessionId, text) => jpost('/api/command', { sessionId, text });

// --- settings (non-secret prefs; API keys are NOT reachable from the phone) ---
export const getSettings = () => jget('/api/settings');
export const saveSettings = (patch) => jpost('/api/settings', patch);

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

// --- chat composer controls ---
export const sessionMode = (id) => jget(`/api/sessions/${id}/mode`);
export const sessionKey = (id, key) => jpost(`/api/sessions/${id}/key`, { key });
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
export function sayUrl(text) {
  const qs = new URLSearchParams({ text });
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
