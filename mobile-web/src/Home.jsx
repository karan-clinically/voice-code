import React, { useEffect, useState } from 'react';
import { listSessions, createSession, transcribe } from './lib/api.js';
import { MicButton, FolderPicker, basename } from './components.jsx';

export default function Home({ onOpen, onHistory, notify }) {
  const [path, setPath] = useState(localStorage.getItem('cvh_lastpath') || '');
  const [sessions, setSessions] = useState([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let stop = false;
    const refresh = () =>
      listSessions()
        .then((d) => !stop && setSessions(d.sessions.filter((s) => s.alive)))
        .catch(() => {});
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
        <button className="ghost" onClick={onHistory} title="Search & resume past sessions">🕘 History</button>
      </header>

      <div className="card stack">
        <h2>Start Claude in a folder</h2>
        <div className="row">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\AI\voice harness" style={{ flex: 1 }} />
          <MicButton
            className="micbtn"
            onBlob={async (blob, ext) => {
              try {
                setPath(await transcribe(blob, ext));
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
              <span>
                <strong>{s.label || basename(s.cwd)}</strong> <span className="muted">· {s.kind || 'claude'}</span>
              </span>
              <span className="pill">{s.state}</span>
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
