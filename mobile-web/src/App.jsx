import React, { useState } from 'react';
import Home from './Home.jsx';
import SessionView from './SessionView.jsx';
import ShellView from './ShellView.jsx';
import History from './History.jsx';
import PlaybackControls from './PlaybackControls.jsx';

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
      {route === 'claude' && <SessionView session={session} onBack={goHome} notify={notify} />}
      <PlaybackControls />
    </>
  );
}
