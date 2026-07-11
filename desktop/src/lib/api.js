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
