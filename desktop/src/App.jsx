import React, { useCallback, useEffect, useState } from 'react';
import { initApi, configState } from './lib/api.js';
import Wizard from './wizard/Wizard.jsx';
import Dashboard from './dashboard/Dashboard.jsx';

function Splash({ text }) {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Claude Code Voice Harness</h1>
      </header>
      <main className="content">
        <div className="card">
          <p className="muted">{text}</p>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState('loading');

  const refresh = useCallback(async () => {
    try {
      const s = await configState();
      setRoute(s.firstRun ? 'wizard' : 'dashboard');
    } catch {
      setRoute('offline');
    }
  }, []);

  useEffect(() => {
    let stop = false;
    (async () => {
      await initApi();
      const tick = async () => {
        if (stop) return;
        try {
          const s = await configState();
          if (!stop) setRoute(s.firstRun ? 'wizard' : 'dashboard');
        } catch {
          if (!stop) {
            setRoute('offline');
            setTimeout(tick, 2000); // harness still booting
          }
        }
      };
      tick();
    })();
    return () => {
      stop = true;
    };
  }, []);

  if (route === 'loading') return <Splash text="Starting…" />;
  if (route === 'offline') return <Splash text="Waiting for the harness to start…" />;
  if (route === 'wizard') return <Wizard onDone={refresh} />;
  return <Dashboard onOpenWizard={() => setRoute('wizard')} />;
}
