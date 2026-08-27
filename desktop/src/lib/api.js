// Thin client to the harness REST + WS API. On localhost the harness bypasses
// auth, so no token is needed from the desktop app. Served as a plain web page
// (harness /desktop route — no Electron bridge), it targets its own origin
// instead: auth there is the transport's job (Cloudflare Access cookie or
// tailnet identity), so no token handling is needed here either.

let baseUrl = 'http://localhost:4620';

export async function initApi() {
  try {
    const info = await window.cvh?.appInfo();
    if (info?.port) {
      baseUrl = `http://localhost:${info.port}`;
      return baseUrl;
    }
  } catch {
    /* keep default */
  }
  if (!window.cvh && import.meta.env.PROD && /^https?:/.test(location.origin)) {
    baseUrl = location.origin;
  }
  return baseUrl;
}

export function getBaseUrl() {
  return baseUrl;
}

async function handle(r) {
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status; // lets App.jsx route a served client to /login on 401
    throw err;
  }
  return data;
}

// `no-store`: every GET here reads LIVE state, and the polls hit a fixed URL
// (the chat view asks for `?after=0` for the whole of a conversation). With no
// cache directive the browser is free to keep serving its stored copy of that
// URL, which showed up as a chat that only updated when the page was reloaded.
export async function apiGet(path) {
  return handle(await fetch(baseUrl + path, { cache: 'no-store' }));
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

export async function apiDelete(path) {
  return handle(await fetch(baseUrl + path, { method: 'DELETE' }));
}

export async function apiPostForm(path, formData) {
  return handle(await fetch(baseUrl + path, { method: 'POST', body: formData }));
}

export async function health() {
  return apiGet('/api/health');
}

// The live session feed. This socket is the ONLY push channel the dashboard has
// (session list, per-session state, logs, spoken turns), so when it never opens
// the whole UI silently freezes until the page is reloaded. That is not
// hypothetical: corporate proxies routinely pass ordinary HTTPS but refuse the
// WebSocket upgrade, and any connection can drop. So: reconnect with backoff, and
// tell the caller whether the socket is currently delivering, so it can fall back
// to polling instead of showing stale state indefinitely.
export function openWs(onMessage, onStatus) {
  let socket = null;
  let retry = null;
  let delay = 1000;
  let stopped = false;

  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 15000); // a blocked proxy must not be retried hot
  };

  function connect() {
    if (stopped) return;
    let next;
    try {
      next = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
    } catch {
      schedule(); // some browsers throw outright when the scheme is blocked
      return;
    }
    socket = next;
    next.onopen = () => {
      if (socket !== next) return;
      delay = 1000;
      onStatus?.(true);
    };
    next.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    next.onerror = () => {
      if (socket === next) try { next.close(); } catch { /* onclose retries */ }
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      onStatus?.(false);
      schedule();
    };
  }

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(retry);
      try { socket?.close(); } catch { /* already gone */ }
    },
  };
}

export function ttsUrl(interactionId) {
  return `${baseUrl}/api/tts/${interactionId}`;
}

// Raw terminal WebSocket for a session (localhost bypasses auth).
export function termWsUrl(sessionId) {
  return `${baseUrl.replace(/^http/, 'ws')}/ws/term?session=${sessionId}`;
}

// Live speech-to-text WebSocket (localhost bypasses auth).
export function sttWsUrl(lang) {
  return `${baseUrl.replace(/^http/, 'ws')}/ws/stt${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`;
}

// STT for desktop push-to-talk. cleanup=true runs Wispr-style dictation cleanup
// server-side; returns { text }.
export async function transcribeAudio(blob, ext = 'webm', { cleanup = true } = {}) {
  const fd = new FormData();
  fd.append('audio', blob, `clip.${ext}`);
  fd.append('cleanup', String(cleanup));
  return handle(await fetch(baseUrl + '/api/transcribe', { method: 'POST', body: fd }));
}

// Speak arbitrary text. Returns a URL for an <audio>/Audio element to fetch
// itself, so playback starts on the first mp3 frames (~300ms) instead of after
// the full render. Buffering this into a Blob first would throw the streaming
// away — hand the URL to the element, don't fetch() it.
export function ttsSayUrl(text) {
  return `${baseUrl}/api/tts/say?text=${encodeURIComponent(text)}`;
}

// Speak this session's latest Claude reply: 'summary' (the short spoken version)
// or 'full' (the whole answer, verbatim). Keyed by session so the text stays
// harness-side — passing a long reply up the URL hit /say's length cap and read
// the markdown symbols aloud.
export function replyUrl(sessionId, mode = 'summary') {
  return `${baseUrl}/api/tts/reply/${sessionId}?mode=${mode}`;
}

// --- wizard / config ---
export const configState = () => apiGet('/api/config/state');
export const saveConfig = (obj) => apiPost('/api/config', obj);
export const listVoices = (provider) => apiGet('/api/voices' + (provider ? '?provider=' + encodeURIComponent(provider) : ''));
export const pairingPayload = () => apiGet('/api/pairing/payload');
export const regenToken = () => apiPost('/api/pairing/regen');
export const tailscaleDetect = () => apiGet('/api/tunnel/tailscale');

export async function previewVoiceUrl(voiceId, provider) {
  const r = await fetch(baseUrl + '/api/voices/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceId, provider }),
  });
  if (!r.ok) throw new Error('voice preview failed');
  return URL.createObjectURL(await r.blob());
}

// Directory listing for the served dashboard's folder picker (no Electron bridge,
// so no native dialog). Empty path returns the drive letters.
export const fsList = (path) => apiGet('/api/fs/list' + (path ? '?path=' + encodeURIComponent(path) : ''));

// --- sessions / command ---
export const listSessions = () => apiGet('/api/sessions');
export const listProviders = () => apiGet('/api/providers');
export const saveCustomProvider = (definition) => apiPost('/api/providers', definition);
export const deleteCustomProvider = (id) => apiDelete(`/api/providers/${encodeURIComponent(id)}`);
export const saveProviderCredential = (id, value) =>
  apiPost(`/api/providers/${encodeURIComponent(id)}/credential`, { value });
// kind: 'claude' | 'grok' | 'codex' | 'shell' — defaults to claude on the server.
export const createSession = (cwd, label, providerId = 'claude') =>
  apiPost('/api/sessions', { cwd, label, providerId, forceNew: true });
export const killSession = (id) => apiPost(`/api/sessions/${id}/kill`, {});
export const startSessionPreview = (id) => apiPost(`/api/sessions/${id}/preview/start`, {});
export const stopSessionPreview = (id) => apiPost(`/api/sessions/${id}/preview/stop`, {});
export const renameSession = (id, label) => apiPost(`/api/sessions/${id}/rename`, { label });
export const setSessionColor = (id, color) => apiPost(`/api/sessions/${id}/color`, { color });
export const handoffSession = (id, providerId, model = null) =>
  apiPost(`/api/sessions/${id}/handoff`, { providerId, ...(model ? { model } : {}) });
export const sendCommand = (sessionId, text) => apiPost('/api/command', { sessionId, text });
// Store a file on the harness host and get back its local path — what the CLIs
// read. Used for pasted screenshots when there is no Electron clipboard bridge.
export const attachFile = (id, file) => {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return apiPostForm(`/api/sessions/${id}/attach`, fd);
};

// --- session archive (past transcripts) ---
export const searchArchive = (q = '', project = '') =>
  apiGet('/api/archive?' + new URLSearchParams({ q, ...(project ? { project } : {}) }).toString());
export const archiveProjects = () => apiGet('/api/archive/projects');
export const archiveDetail = (uuid) => apiGet('/api/archive/' + encodeURIComponent(uuid));
export const resumeArchive = (uuid) => apiPost(`/api/archive/${encodeURIComponent(uuid)}/resume`, {});

// --- chat view (conversation log) ---
export const sessionMessages = (id, after = 0) => apiGet(`/api/sessions/${id}/messages?after=${after}`);
export const sessionPromptHistory = (id) => apiGet(`/api/sessions/${id}/messages?limit=100`);
export const sendChat = (id, text) => apiPost(`/api/sessions/${id}/chat`, { text });

// --- chat composer controls ---
export const sessionMode = (id) => apiGet(`/api/sessions/${id}/mode`);
export const sessionKey = (id, key) => apiPost(`/api/sessions/${id}/key`, { key });
export const setSessionModel = (id, alias) => apiPost(`/api/sessions/${id}/model`, { alias });
export const listPrompts = () => apiGet('/api/prompts');
export const savePrompt = (text, label) => apiPost('/api/prompts', { text, label });
export const deletePrompt = (id) => apiDelete(`/api/prompts/${id}`);
