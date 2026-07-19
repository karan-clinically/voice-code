// Voice Code (Vercel edition) — a voice-first phone UI for cloud Claude agent
// sessions, replacing the Tailscale-served harness build. Sessions run in
// Anthropic's Managed Agents cloud; this app is just a thin authenticated shell.

import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import SessionView from './SessionView.jsx';
import Composer from './Composer.jsx';

const LIST_POLL_MS = 10000;

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;
  return <Main onAuthFail={() => { clearToken(); setAuthed(false); }} />;
}

function TokenGate({ onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setToken(value);
    try {
      await api.setup(); // validates the token and warms agent/environment
      onDone();
    } catch (err) {
      clearToken();
      setError(err.status === 401 ? 'Wrong access token.' : err.message);
    }
  }

  return (
    <div className="gate">
      <h1>Voice Code</h1>
      <p>Enter the access token you set as <code>APP_ACCESS_TOKEN</code> in Vercel.</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access token"
          autoFocus
        />
        <button type="submit" disabled={!value.trim()}>Unlock</button>
      </form>
      {error && <p className="error-bar">{error}</p>}
    </div>
  );
}

function Main({ onAuthFail }) {
  const [sessions, setSessions] = useState([]);
  const [codeSessions, setCodeSessions] = useState(null);
  const [pcs, setPcs] = useState(null);
  const [features, setFeatures] = useState(null);
  const [active, setActive] = useState(null);
  const [error, setError] = useState('');
  const [autoSpeak, setAutoSpeak] = useState(localStorage.getItem('vc_autospeak') !== '0');

  useEffect(() => {
    api.setup()
      .then((s) => setFeatures(s.features))
      .catch((e) => (e.status === 401 ? onAuthFail() : setError(e.message)));
  }, [onAuthFail]);

  // Each data source fails independently — a missing ANTHROPIC_API_KEY (connector-only
  // deployment) must not blank the PC list.
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.listPcs(),
      api.codeSessions(),
      features?.cloud_sessions ? api.listSessions() : Promise.resolve(null),
    ]);
    const [pcsR, codeR, mineR] = results;
    if (results.some((r) => r.status === 'rejected' && r.reason?.status === 401)) {
      onAuthFail();
      return;
    }
    if (pcsR.status === 'fulfilled') setPcs(pcsR.value);
    if (codeR.status === 'fulfilled') setCodeSessions(codeR.value);
    if (mineR.status === 'fulfilled' && mineR.value) setSessions(mineR.value.sessions);
    const firstErr = results.find((r) => r.status === 'rejected');
    setError(firstErr ? firstErr.reason.message : '');
  }, [features, onAuthFail]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  function toggleAutoSpeak() {
    const next = !autoSpeak;
    setAutoSpeak(next);
    localStorage.setItem('vc_autospeak', next ? '1' : '0');
  }

  async function startSession(message) {
    try {
      const session = await api.createSession(null, message);
      setActive({ ...session, status: 'running' });
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeSession(id) {
    if (!window.confirm('Delete this session and its sandbox?')) return;
    try {
      await api.deleteSession(id);
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  if (active) {
    return (
      <SessionView
        session={active}
        autoSpeak={autoSpeak}
        onBack={() => { setActive(null); refresh(); }}
      />
    );
  }

  return (
    <div className="home">
      <header>
        <h1>Voice Code</h1>
        <button className={`ghost ${autoSpeak ? 'on' : ''}`} onClick={toggleAutoSpeak}>
          {autoSpeak ? '🔊 auto' : '🔇 muted'}
        </button>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <PcList pcs={pcs} onForget={async (id) => { await api.forgetPc(id).catch(() => {}); refresh(); }} />

      {features?.cloud_sessions ? (
        <>
          <section>
            <h2>New cloud session</h2>
            <Composer placeholder="Dictate the first command for a new session…" onSend={startSession} />
          </section>

          <section>
            <h2>Cloud agent sessions</h2>
            {sessions.length === 0 && <p className="hint">None yet — start one above.</p>}
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button className="session-row" onClick={() => setActive(s)}>
                    <span className="row-title">{s.title || s.id}</span>
                    <span className={`badge ${s.status}`}>{s.status}</span>
                  </button>
                  <button className="ghost danger" onClick={() => removeSession(s.id)} aria-label="Delete">✕</button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        features && (
          <p className="hint">
            Connector-only mode: this hub just launches into your PCs. To also run PC-free cloud
            agent sessions (billed to an Anthropic API key), add <code>ANTHROPIC_API_KEY</code> and{' '}
            <code>DEEPGRAM_API_KEY</code> in Vercel.
          </p>
        )
      )}

      <CodeSessionsSection codeSessions={codeSessions} />
    </div>
  );
}

// AnyDesk/TeamViewer-style device list. Each PC's harness heartbeats to
// /api/pcs/heartbeat; tapping an online PC opens its own mobile UI (/m) with
// the pairing token in the URL hash — full local PTY sessions, Max-billed.
// Offline PCs stay listed, greyed out, with a last-seen time.
function PcList({ pcs, onForget }) {
  if (!pcs) return null;
  if (!pcs.configured) {
    return (
      <section>
        <h2>My PCs</h2>
        <p className="hint">
          Needs a store for heartbeats: add the free <strong>Upstash Redis</strong> integration to
          this Vercel project, then set <code>HUB_URL</code> + <code>HUB_TOKEN</code> on each PC's
          harness. See web/README.md.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2>My PCs</h2>
      {pcs.pcs.length === 0 && (
        <p className="hint">
          No PCs have announced yet — set <code>HUB_URL</code> + <code>HUB_TOKEN</code> in each
          harness's .env and restart it.
        </p>
      )}
      <ul className="session-list">
        {pcs.pcs.map((pc) => {
          const launchable = pc.online && pc.baseUrl;
          const href = launchable
            ? `${pc.baseUrl.replace(/\/$/, '')}/m/${pc.token ? `#t=${pc.token}` : ''}`
            : undefined;
          const Row = launchable ? 'a' : 'div';
          return (
            <li key={pc.id}>
              <Row
                className={`session-row pc-row ${pc.online ? '' : 'offline'}`}
                href={href}
                target={launchable ? '_blank' : undefined}
                rel={launchable ? 'noreferrer' : undefined}
              >
                <span className="row-title">
                  <span className={`presence-dot ${pc.online ? 'online' : ''}`} />
                  {pc.name}
                  {!pc.online && <span className="row-sub"> · seen {timeAgo(pc.last_seen)}</span>}
                  {pc.online && !pc.baseUrl && <span className="row-sub"> · no tunnel URL</span>}
                </span>
                <span className={`badge ${pc.online ? 'running' : ''}`}>
                  {pc.online ? 'connected' : 'disconnected'}
                </span>
              </Row>
              {!pc.online && (
                <button className="ghost danger" onClick={() => onForget(pc.id)} aria-label="Forget PC">✕</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function CodeSessionsSection({ codeSessions }) {
  return (
    <>
      {codeSessions?.configured && (
        <section>
          <h2>claude.ai/code sessions <span className="hint">(view-only)</span></h2>
          {codeSessions.stale && (
            <p className="hint">OAuth token expired — update CLAUDE_CODE_OAUTH_TOKEN in Vercel.</p>
          )}
          <ul className="session-list">
            {codeSessions.sessions.map((s) => (
              <li key={s.id}>
                <a className="session-row" href={s.url} target="_blank" rel="noreferrer">
                  <span className="row-title">
                    {s.title || s.id}
                    {s.repo && <span className="row-sub"> · {s.repo}</span>}
                  </span>
                  <span className={`badge ${s.working ? 'running' : 'idle'}`}>{s.bucket || '—'}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="hint">
            There's no public API to send prompts into claude.ai/code sessions — these open in the
            Claude app. Voice-driven sessions above run on the Managed Agents API instead.
          </p>
        </section>
      )}
    </>
  );
}
