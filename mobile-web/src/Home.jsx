import React, { useEffect, useState } from 'react';
import { createSession, transcribe, usageSummary, recentSessions, reindexArchive, resumeArchive } from './lib/api.js';
import { MicButton, FolderPicker, basename } from './components.jsx';
import SpendModal, { fmtUsd } from './SpendModal.jsx';
import SettingsModal from './SettingsModal.jsx';

// Raw session states (idle | busy | response_ready) shown as friendly words, and
// mapped to the existing tinted-pill variants.
const STATE_LABEL = { idle: 'Idle', busy: 'Working', response_ready: 'Ready', awaiting_input: 'Waiting' };
const STATE_PILL = { busy: 'busy', response_ready: 'ready', awaiting_input: 'ready' };
function friendlyState(state) {
  return (
    STATE_LABEL[state] ||
    String(state || 'idle').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Short relative time for a session's last activity.
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Home({ onOpen, onHistory, notify }) {
  const [tab, setTab] = useState('start'); // start | sessions
  const [path, setPath] = useState(localStorage.getItem('cvh_lastpath') || '');
  const [recent, setRecent] = useState({ harness: [], remote: [] });
  const [picking, setPicking] = useState(false);
  const [spend, setSpend] = useState(null); // estimated total USD, for the header tally
  const [showSpend, setShowSpend] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let stop = false;
    const refresh = () => {
      recentSessions()
        .then((d) => !stop && setRecent({ harness: d.harness || [], remote: d.remote || [] }))
        .catch(() => {});
      usageSummary()
        .then((d) => !stop && setSpend(d.totalUsd))
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // Freshen the transcript archive when the tab opens so externally-run (remote-
  // controlled) sessions show up promptly — reindex is incremental, so it's cheap.
  useEffect(() => {
    if (tab === 'sessions') reindexArchive().catch(() => {});
  }, [tab]);

  async function startClaude() {
    try {
      const p = path.trim().replace(/["']/g, '');
      const s = await createSession({ kind: 'claude', cwd: p || undefined, label: p ? basename(p) : null });
      if (p) localStorage.setItem('cvh_lastpath', p);
      onOpen(s);
    } catch (e) {
      notify(e.message);
    }
  }
  async function startShell() {
    try {
      onOpen(await createSession({ kind: 'shell' }));
    } catch (e) {
      notify(e.message);
    }
  }
  async function resumeUuid(uuid) {
    try {
      onOpen(await resumeArchive(uuid));
    } catch (e) {
      notify(e.message);
    }
  }

  // A harness-spawned session: tap opens it if live, or resumes it (via its Claude
  // session id) if it ended recently.
  const harnessCard = (s) => {
    const canResume = !!s.claude_session_id;
    const onClick = s.alive ? () => onOpen(s) : canResume ? () => resumeUuid(s.claude_session_id) : undefined;
    return (
      <button key={'h' + s.id} className="sess" onClick={onClick} disabled={!onClick}>
        <span className="sess-main">
          <span className="sess-title">{s.label || basename(s.cwd) || `Session ${s.id}`}</span>
          {s.cwd && <span className="sess-line">{s.cwd}</span>}
          {s.git_repo && <span className="sess-line">{s.git_repo}{s.git_branch ? ` · ${s.git_branch}` : ''}</span>}
          <span className="sess-line sess-meta">
            {s.kind === 'shell' ? 'Shell' : 'Claude'}
            {!s.alive && ` · ended ${timeAgo(s.last_seen_at)}`}
          </span>
        </span>
        <span className={'pill' + (s.alive && STATE_PILL[s.state] ? ' ' + STATE_PILL[s.state] : '')}>
          {s.alive ? friendlyState(s.state) : canResume ? 'Resume' : 'Ended'}
        </span>
      </button>
    );
  };

  // An external (remote-controlled) Claude session, discovered from its transcript.
  // Shows the session id and resumes into a harness PTY when tapped.
  const remoteCard = (s) => (
    <button
      key={'r' + s.uuid}
      className="sess"
      onClick={s.cwdExists ? () => resumeUuid(s.uuid) : undefined}
      disabled={!s.cwdExists}
      title={s.cwdExists ? 'Resume this session' : 'Original folder is gone'}
    >
      <span className="sess-main">
        <span className="sess-title">{s.title || basename(s.cwd) || s.uuid.slice(0, 8)}</span>
        {s.cwd && <span className="sess-line">{s.cwd}</span>}
        <span className="sess-line sess-meta">
          session {s.uuid.slice(0, 8)}
          {s.lastTs ? ` · ${timeAgo(s.lastTs)}` : ''}
        </span>
      </span>
      <span className={'pill' + (s.active ? ' ready' : '')}>{s.active ? 'Active' : 'Resume'}</span>
    </button>
  );

  const total = recent.harness.length + recent.remote.length;

  return (
    <div>
      <header className="topbar">
        <button className="ghost hamburger" onClick={() => setShowSettings(true)} title="Settings">☰</button>
        <h1>Voice Harness</h1>
        <div className="spacer" />
        <button className="ghost spend-btn" onClick={() => setShowSpend(true)} title="Estimated API spend">
          💲{spend != null ? ` ${fmtUsd(spend)}` : ''}
        </button>
        <button className="ghost" onClick={onHistory} title="Search & resume past sessions">🕘 History</button>
      </header>

      {showSpend && <SpendModal onClose={() => setShowSpend(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} notify={notify} />}

      <div className="tabstrip">
        <button className={'tab' + (tab === 'start' ? ' on' : '')} onClick={() => setTab('start')}>Start</button>
        <button className={'tab' + (tab === 'sessions' ? ' on' : '')} onClick={() => setTab('sessions')}>
          Sessions
          {total > 0 && <span className="tab-n">{total}</span>}
        </button>
      </div>

      {tab === 'start' && (
        <>
          <div className="card stack">
            <h2>Start Claude in a folder</h2>
            <div className="row">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\AI\voice harness" style={{ flex: 1 }} />
              <MicButton
                className="micbtn"
                onBlob={async (blob, ext) => {
                  try {
                    // No cleanup here — this is a folder path, not an instruction; the
                    // dictation rewrite would happily mangle it.
                    setPath(await transcribe(blob, ext, { cleanup: false }));
                  } catch (e) {
                    notify(e.message);
                  }
                }}
                notify={notify}
              />
            </div>
            <div className="row">
              <button style={{ flex: 1 }} onClick={() => setPicking(true)}>📁 Browse…</button>
              <button className="primary" style={{ flex: 1 }} onClick={startClaude}>Start Claude here</button>
            </div>
          </div>

          <div className="card stack">
            <h2>Start a shell to navigate</h2>
            <p className="muted">Opens PowerShell in your projects base. cd/ls to the right folder, hear where you are, then Launch Claude.</p>
            <button onClick={startShell}>Start shell</button>
          </div>
        </>
      )}

      {tab === 'sessions' && (
        total === 0 ? (
          <div className="card">
            <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
              No recent sessions. Start one from the Start tab — or run Claude in any terminal and it'll appear under
              Remote control.
            </p>
          </div>
        ) : (
          <>
            {recent.harness.length > 0 && (
              <div className="sess-group">
                <div className="sess-group-head">
                  <span className="sess-group-title">In the harness</span>
                  <span className="sess-group-sub">Started on this PC · live + recently ended</span>
                </div>
                <div className="stack">{recent.harness.map(harnessCard)}</div>
              </div>
            )}
            {recent.remote.length > 0 && (
              <div className="sess-group">
                <div className="sess-group-head">
                  <span className="sess-group-title">Remote control</span>
                  <span className="sess-group-sub">Started in another terminal</span>
                </div>
                <div className="stack">{recent.remote.map(remoteCard)}</div>
              </div>
            )}
          </>
        )
      )}

      {picking && (
        <FolderPicker
          start={path.trim().replace(/["']/g, '') || 'C:/AI'}
          onPick={(p) => {
            setPath(p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
          notify={notify}
        />
      )}
    </div>
  );
}
