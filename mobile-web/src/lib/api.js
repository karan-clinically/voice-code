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
export const mediaUrl = (u) => base + u + (authQS ? (u.includes('?') ? '&' : '?') + authQS : '');

export const listSessions = () => jget('/api/sessions');
export const createSession = (body) => jpost('/api/sessions', body);
export const killSession = (id) => jpost(`/api/sessions/${id}/kill`);
export const sessionScreen = (id) => jget(`/api/sessions/${id}/screen?full=1&color=1`);
export const sessionScreenPlain = (id) => jget(`/api/sessions/${id}/screen?full=1`);
export const sessionInput = (id, text) => jpost(`/api/sessions/${id}/input`, { text });
export const launchClaudeIn = (id) => jpost(`/api/sessions/${id}/launch-claude`);
export const fsList = (path) => jget('/api/fs/list' + (path ? '?path=' + encodeURIComponent(path) : ''));
export const transcribe = async (blob, ext) => {
  const fd = new FormData();
  fd.append('audio', blob, 'clip.' + ext);
  return (await jform('/api/transcribe', fd)).text || '';
};
export const commandText = (sessionId, text) => jpost('/api/command', { sessionId, text });
export const commandAudio = (fd) => jform('/api/command', fd);

export async function sayBlobUrl(text) {
  const r = await fetch(base + '/api/tts/say', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('say failed');
  return URL.createObjectURL(await r.blob());
}
