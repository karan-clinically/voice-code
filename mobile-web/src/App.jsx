import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import SessionView from './SessionView.jsx';
import ShellView from './ShellView.jsx';
import History from './History.jsx';
import PlaybackControls from './PlaybackControls.jsx';
import { sessionInfo, sayUrl, replyUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';

export default function App() {
  const [route, setRoute] = useState('home'); // home | shell | claude | history
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  // App-wide toast. Everything funnels through here as an error by default;
  // pass kind 'info' for neutral notices (e.g. the permission-mode switcher) so
  // they don't dress up as failures — info also clears faster.
  const notify = (m, kind = 'err') => {
    setError({ text: m, kind });
    setTimeout(() => setError(''), kind === 'err' ? 6000 : 2500);
  };
  const goHome = () => {
    setSession(null);
    setRoute('home');
  };
  const openSession = (s) => {
    setSession(s);
    setRoute((s.kind || 'claude') === 'shell' ? 'shell' : 'claude');
  };

  // Speak a session's latest reply — or the question it's waiting on, when the service
  // worker passes one. This is what the notification's ▶ Play button ends up calling,
  // from wherever you are in the app.
  const speak = (sessionId, say) => {
    try {
      playUrl(say ? sayUrl(say) : replyUrl(sessionId, 'summary'));
    } catch (e) {
      notify(e.message);
    }
  };
  const jumpTo = (id, play) =>
    sessionInfo(id)
      .then((s) => {
        if (s?.id && s.alive !== false) openSession(s);
        if (play) speak(id, null);
      })
      .catch(() => {});

  // Deep link: the app was launched (cold) by a tapped notification — /m?s=<id>, plus
  // &play=1 when it was the Play button. Clean the URL so a refresh doesn't replay it.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const id = q.get('s');
    if (!id) return;
    history.replaceState(null, '', location.pathname);
    jumpTo(id, q.get('play') === '1');
  }, []);

  // The app was already running when the notification was tapped — the worker messages us
  // rather than reloading, so a tap switches session in place and Play speaks without
  // leaving the screen you're on.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === 'open-session' && d.sessionId) jumpTo(d.sessionId, d.play);
      else if (d.type === 'speak' && d.sessionId) speak(d.sessionId, d.say);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  return (
    <>
      {error && (
        <div
          className={'banner ' + (error.kind === 'info' ? 'info' : 'err')}
          style={{ position: 'fixed', top: 8, left: 12, right: 12, zIndex: 100, margin: 0 }}
        >
          {error.text}
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
