import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import SessionView from './SessionView.jsx';
import ShellView from './ShellView.jsx';
import History from './History.jsx';
import PlaybackControls from './PlaybackControls.jsx';
import { sessionInfo } from './lib/api.js';

export default function App() {
  const [route, setRoute] = useState('home'); // home | shell | claude | history
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  const notify = (m) => {
    setError(m);
    setTimeout(() => setError(''), 6000);
  };
  const goHome = () => {
    setSession(null);
    setRoute('home');
  };
  const openSession = (s) => {
    setSession(s);
    setRoute((s.kind || 'claude') === 'shell' ? 'shell' : 'claude');
  };

  // Deep link: a tapped push notification opens /m?s=<id> — jump straight into
  // that session, then clean the URL so a refresh doesn't reopen it.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('s');
    if (!id) return;
    history.replaceState(null, '', location.pathname);
    sessionInfo(id)
      .then((s) => { if (s?.id && s.alive !== false) openSession(s); })
      .catch(() => {});
  }, []);

  return (
    <>
      {error && (
        <div className="banner err" style={{ position: 'fixed', top: 8, left: 12, right: 12, zIndex: 100, margin: 0 }}>
          {error}
        </div>
      )}
      {route === 'home' && <Home onOpen={openSession} onHistory={() => setRoute('history')} notify={notify} />}
      {route === 'history' && <History onOpen={openSession} onBack={goHome} notify={notify} />}
      {route === 'shell' && (
        <ShellView
          session={session}
          onLaunched={(s) => {
            setSession(s);
            setRoute('claude');
          }}
          onBack={goHome}
          notify={notify}
        />
      )}
      {route === 'claude' && (
        <SessionView key={session?.id} session={session} onBack={goHome} onOpen={openSession} notify={notify} />
      )}
      <PlaybackControls />
    </>
  );
}
