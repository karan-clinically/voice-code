import React, { useEffect, useState } from 'react';
import { listSessions, createSession, transcribe, usageSummary } from './lib/api.js';
import { MicButton, FolderPicker, SttModeToggle, TtsProviderToggle, basename } from './components.jsx';
import SpendModal, { fmtUsd } from './SpendModal.jsx';

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

export default function Home({ onOpen, onHistory, notify }) {
  const [path, setPath] = useState(localStorage.getItem('cvh_lastpath') || '');
  const [sessions, setSessions] = useState([]);
  const [picking, setPicking] = useState(false);
  const [spend, setSpend] = useState(null); // estimated total USD, for the header tally
  const [showSpend, setShowSpend] = useState(false);

  useEffect(() => {
    let stop = false;
    const refresh = () => {
      listSessions()
        .then((d) => !stop && setSessions(d.sessions.filter((s) => s.alive)))
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

  return (
    <div>
      <header className="topbar">
        <h1>Voice Harness</h1>
        <div className="spacer" />
        <button className="ghost spend-btn" onClick={() => setShowSpend(true)} title="Estimated API spend">
          💲{spend != null ? ` ${fmtUsd(spend)}` : ''}
        </button>
        <button className="ghost" onClick={onHistory} title="Search & resume past sessions">🕘 History</button>
      </header>

      {showSpend && <SpendModal onClose={() => setShowSpend(false)} />}

      <div className="card stack">
        <div className="row" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <strong>Dictation</strong>
            <div className="muted">
              Batch transcribes when you stop; Live shows words as you speak. Either way the text lands in the box —
              nothing sends until you tap Send.
            </div>
          </div>
          <SttModeToggle notify={notify} />
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <strong>Voice provider</strong>
            <div className="muted">
              Runs both halves — listening and speaking — on one vendor, so it's a single key and credit pool. Deepgram
              is fast and clear; ElevenLabs is more expressive.
            </div>
          </div>
          <TtsProviderToggle notify={notify} />
        </div>
      </div>

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

      {sessions.length > 0 && (
        <div className="card stack">
          <h2>Resume a session</h2>
          {sessions.map((s) => (
            <button key={s.id} className="sess" onClick={() => onOpen(s)}>
              <span className="sess-main">
                <span className="sess-title">{s.label || basename(s.cwd)}</span>
                {s.cwd && <span className="sess-line">{s.cwd}</span>}
                {s.git_repo && (
                  <span className="sess-line">{s.git_repo}{s.git_branch ? ` · ${s.git_branch}` : ''}</span>
                )}
                <span className="sess-line sess-meta">{s.kind === 'shell' ? 'Shell' : 'Claude'}</span>
              </span>
              <span className={'pill' + (STATE_PILL[s.state] ? ' ' + STATE_PILL[s.state] : '')}>
                {friendlyState(s.state)}
              </span>
            </button>
          ))}
        </div>
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
