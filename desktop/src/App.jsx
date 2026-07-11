import React, { useEffect, useRef, useState } from 'react';
import { initApi, health } from './lib/api.js';

// Step 10 shell: boot status + live harness log. Wizard/Dashboard routing is
// added in steps 11-12.
export default function App() {
  const [status, setStatus] = useState('connecting');
  const [version, setVersion] = useState('');
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let timer = null;
    let off = null;

    (async () => {
      await initApi();
      const poll = async () => {
        try {
          const h = await health();
          if (alive) {
            setStatus('online');
            setVersion(h.version);
          }
        } catch {
          if (alive) setStatus('offline');
        }
      };
      poll();
      timer = setInterval(poll, 2000);
      off = window.cvh?.onHarnessLog?.((txt) => setLogs((l) => [...l.slice(-300), txt]));
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (off) off();
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Claude Code Voice Harness</h1>
        <div className="spacer" />
        <span className="status-pill">
          <span className={`dot ${status}`} />
          {status === 'online' ? `harness online · v${version}` : status}
        </span>
      </header>

      <main className="content">
        <div className="card">
          <span className="label">Backend</span>
          <h2>Harness {status === 'online' ? 'is running' : status}</h2>
          <p className="muted">
            The desktop app manages the harness backend and talks to it over localhost.
            The setup wizard and session dashboard appear here once wired (steps 11–12).
          </p>
        </div>

        <div className="card">
          <span className="label">Harness log</span>
          <div className="logbox" ref={logRef}>
            {logs.length ? logs.join('') : 'waiting for harness output…'}
          </div>
        </div>
      </main>
    </div>
  );
}
