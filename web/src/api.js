// Client for the Vercel serverless API. Same-origin, bearer-token auth.
// The token is entered once and kept in localStorage — the pairing-QR flow from
// the harness era doesn't apply here (there's no localhost to bootstrap from).

const TOKEN_KEY = 'vc_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t.trim());
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, raw } = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  let payload;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      headers['content-type'] = 'application/octet-stream';
      if (raw?.audioType) headers['x-audio-type'] = raw.audioType;
      payload = body;
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const r = await fetch(path, { method, headers, body: payload });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error || `${method} ${path} failed (${r.status})`);
  return data;
}

export const api = {
  setup: () => request('/api/setup'),
  listSessions: () => request('/api/sessions'),
  createSession: (title, message) => request('/api/sessions', { method: 'POST', body: { title, message } }),
  getSession: (id) => request(`/api/sessions/${id}`),
  deleteSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),
  getEvents: (id) => request(`/api/sessions/${id}/events`),
  sendMessage: (id, text) => request(`/api/sessions/${id}/events`, { method: 'POST', body: { text } }),
  interrupt: (id) => request(`/api/sessions/${id}/events`, { method: 'POST', body: { interrupt: true } }),
  codeSessions: () => request('/api/code-sessions'),
  sttToken: () => request('/api/stt-token'),
  transcribe: (blob, audioType) =>
    request('/api/transcribe', { method: 'POST', body: blob, raw: { audioType } }),
};

// <audio> can't send headers, so the tts route accepts ?token=.
export function ttsUrl(text) {
  const q = new URLSearchParams({ text: text.slice(0, 1900), token: getToken() });
  return `/api/tts?${q}`;
}

export { ApiError };
