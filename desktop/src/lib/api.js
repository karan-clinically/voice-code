// Thin client to the harness REST + WS API. On localhost the harness bypasses
// auth, so no token is needed from the desktop app.

let baseUrl = 'http://localhost:4620';

export async function initApi() {
  try {
    const info = await window.cvh?.appInfo();
    if (info?.port) baseUrl = `http://localhost:${info.port}`;
  } catch {
    /* keep default */
  }
  return baseUrl;
}

export function getBaseUrl() {
  return baseUrl;
}

async function handle(r) {
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

export async function apiGet(path) {
  return handle(await fetch(baseUrl + path));
}

export async function apiPost(path, body) {
  return handle(
    await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  );
}

export async function apiPostForm(path, formData) {
  return handle(await fetch(baseUrl + path, { method: 'POST', body: formData }));
}

export async function health() {
  return apiGet('/api/health');
}

export function openWs(onMessage) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      /* ignore malformed */
    }
  };
  return ws;
}

export function ttsUrl(interactionId) {
  return `${baseUrl}/api/tts/${interactionId}`;
}

// Raw terminal WebSocket for a session (localhost bypasses auth).
export function termWsUrl(sessionId) {
  return `${baseUrl.replace(/^http/, 'ws')}/ws/term?session=${sessionId}`;
}

// STT for desktop push-to-talk. cleanup=true runs Wispr-style dictation cleanup
// server-side; returns { text }.
export async function transcribeAudio(blob, ext = 'webm', { cleanup = true } = {}) {
  const fd = new FormData();
  fd.append('audio', blob, `clip.${ext}`);
  fd.append('cleanup', String(cleanup));
  return handle(await fetch(baseUrl + '/api/transcribe', { method: 'POST', body: fd }));
}

// Speak arbitrary text → returns an object URL for the mp3.
export async function ttsSay(text) {
  const r = await fetch(baseUrl + '/api/tts/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('tts failed');
  return URL.createObjectURL(await r.blob());
}

// --- wizard / config ---
export const configState = () => apiGet('/api/config/state');
export const saveConfig = (obj) => apiPost('/api/config', obj);
export const listVoices = () => apiGet('/api/voices');
export const pairingPayload = () => apiGet('/api/pairing/payload');
export const regenToken = () => apiPost('/api/pairing/regen');
export const tailscaleDetect = () => apiGet('/api/tunnel/tailscale');

export async function previewVoiceUrl(voiceId) {
  const r = await fetch(baseUrl + '/api/voices/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceId }),
  });
  if (!r.ok) throw new Error('voice preview failed');
  return URL.createObjectURL(await r.blob());
}

// --- sessions / command ---
export const listSessions = () => apiGet('/api/sessions');
export const createSession = (cwd, label) => apiPost('/api/sessions', { cwd, label });
export const killSession = (id) => apiPost(`/api/sessions/${id}/kill`, {});
export const renameSession = (id, label) => apiPost(`/api/sessions/${id}/rename`, { label });
export const sendCommand = (sessionId, text) => apiPost('/api/command', { sessionId, text });

// --- session archive (past transcripts) ---
export const searchArchive = (q = '', project = '') =>
  apiGet('/api/archive?' + new URLSearchParams({ q, ...(project ? { project } : {}) }).toString());
export const archiveProjects = () => apiGet('/api/archive/projects');
export const archiveDetail = (uuid) => apiGet('/api/archive/' + encodeURIComponent(uuid));
export const resumeArchive = (uuid) => apiPost(`/api/archive/${encodeURIComponent(uuid)}/resume`, {});

// --- chat view (conversation log) ---
export const sessionMessages = (id, after = 0) => apiGet(`/api/sessions/${id}/messages?after=${after}`);
export const sendChat = (id, text) => apiPost(`/api/sessions/${id}/chat`, { text });
