import React, { useEffect, useState } from 'react';
import { createSession, transcribe, usageSummary, recentSessions, reindexArchive, resumeArchive } from './lib/api.js';
import { MicButton, FolderPicker, basename } from './components.jsx';
import SpendModal, { fmtUsd } from './SpendModal.jsx';
import SettingsModal from './SettingsModal.jsx';

// Avatar glyph by where a session was started.
const ORIGIN_ICON = { phone: '📱', pc: '🖥️', terminal: '⌨️' };

// Compact relative time, like the Claude Code app ("now", "4m", "8h", "3d").
function shortAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Day bucket header (Today / Yesterday / Earlier) for a session's last activity.
const BUCKETS = ['Today', 'Yesterday', 'Earlier'];
function dayBucket(ts) {
  const t = Date.parse(ts);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startToday) return 'Today';
  if (t >= startToday - 86400000) return 'Yesterday';
  return 'Earlier';
}

export default function Home({ onOpen, onHistory, notify }) {
  const [tab, setTab] = useState('start'); // start | sessions
  const [path, setPath] = useState(localStorage.getItem('cvh_lastpath') || '');
  const [sessions, setSessions] = useState([]);
  const [picking, setPicking] = useState(false);
  const [spend, setSpend] = useState(null); // estimated total USD, for the header tally
  const [showSpend, setShowSpend] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let stop = false;
    const refresh = () => {
      recentSessions()
        .then((d) => !stop && setSessions(d.sessions || []))
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

  // Tap: open a live harness session directly; resume any other into a harness PTY.
  const canOpen = (it) => (it.kind === 'harness' && it.alive) || !!it.resumeUuid;
  function openItem(it) {
    if (it.kind === 'harness' && it.alive) {
      onOpen({ id: it.harnessId, kind: it.shell ? 'shell' : 'claude', label: it.name, cwd: it.cwd });
    } else if (it.resumeUuid) {
      resumeUuid(it.resumeUuid);
    }
  }

  // One session row, styled like the Claude Code app: avatar, name + time, a
  // connection status with where it was started, then repo/branch + session id.
  const sessionRow = (it) => {
    const source = it.repo ? (it.branch ? `${it.repo} · ${it.branch}` : it.repo) : it.cwd ? basename(it.cwd) : '';
    const sub = [source, it.sessionId ? `session ${it.sessionId.slice(0, 8)}` : ''].filter(Boolean).join('  ·  ');
    const openable = canOpen(it);
    return (
      <button key={it.key} className="cc-item" onClick={openable ? () => openItem(it) : undefined} disabled={!openable}>
        <span className={'cc-avatar cc-' + it.origin}>{ORIGIN_ICON[it.origin] || '⌨️'}</span>
        <span className="cc-body">
          <span className="cc-line1">
            <span className="cc-name">{it.name}</span>
            <span className="cc-time">{shortAgo(it.ts)}</span>
          </span>
          <span className="cc-status">
            <span className={'cc-dot' + (it.connected ? ' on' : '')} />
            <span className={'cc-conn' + (it.connected ? ' on' : '')}>{it.connected ? 'Connected' : 'Disconnected'}</span>
            <span className="cc-sep">·</span>
            <span className="cc-origin">{it.originLabel}</span>
          </span>
          {sub && <span className="cc-sub">{sub}</span>}
        </span>
      </button>
    );
  };

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
          {sessions.length > 0 && <span className="tab-n">{sessions.length}</span>}
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
        sessions.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
              No active sessions. Start one from the Start tab, or drive Claude from another terminal and it'll appear
              here. Past sessions live in 🕘 History.
            </p>
          </div>
        ) : (
          BUCKETS.map((b) => {
            const rows = sessions.filter((s) => dayBucket(s.ts) === b);
            if (rows.length === 0) return null;
            return (
              <div key={b} className="cc-group">
                <div className="cc-group-head">{b}</div>
                <div className="cc-list">{rows.map(sessionRow)}</div>
              </div>
            );
          })
        )
      )}

      {tab === 'sessions' && (
        <button className="cc-fab" onClick={() => setTab('start')}>＋ New session</button>
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
