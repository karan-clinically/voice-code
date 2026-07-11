import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listSessions, createSession, openWs } from '../lib/api.js';
import SessionCard from './SessionCard.jsx';
import SessionDetail from './SessionDetail.jsx';
import LiveLog from './LiveLog.jsx';

export default function Dashboard({ onOpenWizard }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [responseTick, setResponseTick] = useState(0);
  const wsRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { sessions: s } = await listSessions();
      setSessions(s);
    } catch {
      /* harness may be restarting */
    }
  }, []);

  useEffect(() => {
    refresh();
    const ws = openWs((m) => {
      if (m.type === 'sessions') setSessions(m.sessions);
      else if (m.type === 'state') setSessions((prev) => prev.map((x) => (x.id === m.sessionId ? { ...x, state: m.state } : x)));
      else if (m.type === 'log') setLogs((l) => [...l.slice(-300), m]);
      else if (m.type === 'response') setResponseTick(Date.now());
    });
    wsRef.current = ws;
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [refresh]);

  async function newSession() {
    const dir = await window.cvh?.pickFolder();
    if (!dir) return;
    try {
      const s = await createSession(dir, null);
      setSelectedId(s.id);
    } catch (e) {
      alert('Could not start session: ' + e.message);
    }
  }

  const selected = sessions.find((s) => s.id === selectedId);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Claude Code Voice Harness</h1>
        <div className="spacer" />
        <button onClick={newSession}>+ New session</button>
        <button onClick={() => setShowLog((v) => !v)}>{showLog ? 'Hide log' : 'Live log'}</button>
        <button onClick={onOpenWizard} title="Settings">⚙</button>
      </header>

      <main className="content" style={{ maxWidth: 1100 }}>
        {selected ? (
          <SessionDetail
            session={selected}
            onBack={() => setSelectedId(null)}
            refreshSignal={responseTick}
          />
        ) : (
          <>
            {sessions.length === 0 && (
              <div className="card">
                <p className="muted">
                  No sessions yet. Click <strong>+ New session</strong> and pick a folder to launch Claude Code there.
                </p>
              </div>
            )}
            <div className="grid">
              {sessions.map((s) => (
                <SessionCard key={s.id} session={s} onOpen={() => setSelectedId(s.id)} />
              ))}
            </div>
          </>
        )}
        {showLog && <LiveLog logs={logs} />}
      </main>
    </div>
  );
}
