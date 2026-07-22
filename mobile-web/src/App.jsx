import React, { useEffect, useRef, useState } from 'react';
import Home from './Home.jsx';
import SessionView from './SessionView.jsx';
import ShellView from './ShellView.jsx';
import History from './History.jsx';
import PlaybackControls from './PlaybackControls.jsx';
import { sessionInfo, sayUrl, replyUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';

const ACTIVE_SESSION_KEY = 'cvh_active_session';

function savedSessionId() {
  try { return sessionStorage.getItem(ACTIVE_SESSION_KEY); } catch { return null; }
}

function sessionUrl(id) {
  const q = new URLSearchParams(location.search);
  q.set('s', String(id));
  q.delete('play');
  return location.pathname + '?' + q.toString();
}

function rememberSession(id, { replace = false } = {}) {
  if (!id) return;
  try { sessionStorage.setItem(ACTIVE_SESSION_KEY, String(id)); } catch { /* ignore */ }
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ cvhRoute: 'session', sessionId: String(id) }, '', sessionUrl(id));
}

function forgetSession({ updateUrl = true } = {}) {
  try { sessionStorage.removeItem(ACTIVE_SESSION_KEY); } catch { /* ignore */ }
  if (!updateUrl) return;
  const q = new URLSearchParams(location.search);
  q.delete('s');
  q.delete('play');
  const suffix = q.toString();
  history.replaceState({ cvhRoute: 'home' }, '', location.pathname + (suffix ? '?' + suffix : ''));
}

export default function App() {
  const [route, setRoute] = useState('home'); // home | shell | claude | history
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [openingSession, setOpeningSession] = useState(false);
  const [quickSwitchSignal, setQuickSwitchSignal] = useState(0);
  const [newSessionRequested, setNewSessionRequested] = useState(false);
  const explicitBack = useRef(false);

  // App-wide toast. Everything funnels through here as an error by default;
  // pass kind 'info' for neutral notices (e.g. the permission-mode switcher) so
  // they don't dress up as failures — info also clears faster.
  const notify = (m, kind = 'err') => {
    setError({ text: m, kind });
    setTimeout(() => setError(''), kind === 'err' ? 6000 : 2500);
  };
  const goHome = () => {
    // A session opened from Home owns one browser-history entry. Let the browser
    // consume it. The flag distinguishes this explicit arrow from a phone back-swipe,
    // which opens the quick tab switcher instead.
    if (history.state?.cvhRoute === 'session') {
      explicitBack.current = true;
      history.back();
      return;
    }
    forgetSession();
    setSession(null);
    setRoute('home');
  };
  const openSession = (s, { replaceHistory = false } = {}) => {
    // Switching between already-open tabs replaces the session entry. Home ->
    // Session still pushes one entry, preserving a reliable explicit Back target.
    const replace = replaceHistory || history.state?.cvhRoute === 'session';
    rememberSession(s.id, { replace });
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
  const jumpTo = (id, play, options) => {
    setOpeningSession(true);
    return sessionInfo(id)
      .then((s) => {
        if (s?.id && s.alive !== false) openSession(s, options);
        else forgetSession();
        if (play) speak(id, null);
      })
      .catch(() => {})
      .finally(() => setOpeningSession(false));
  };

  // Deep link or reload recovery. Keep `s` in the URL/session storage so a shipped
  // frontend build returns to the exact PTY; remove only the one-shot `play` flag.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const id = q.get('s') || savedSessionId();
    if (!id) return;
    const play = q.get('play') === '1';
    // A cold deep link has no in-app entry behind it. Turn the current entry into
    // Home, then push the requested session, so an iOS/Android back-swipe returns
    // to Sessions instead of leaving the PWA (which looked like a logout).
    q.delete('play');
    q.delete('s');
    const suffix = q.toString();
    history.replaceState({ cvhRoute: 'home' }, '', location.pathname + (suffix ? '?' + suffix : ''));
    jumpTo(id, play);
  }, []);

  // Browser back, Android back, and iOS edge-swipe all arrive here. A native back
  // gesture inside Claude becomes the quick switcher; explicit navigation continues
  // to follow the URL normally.
  useEffect(() => {
    const onPopState = () => {
      const allowNavigation = explicitBack.current;
      explicitBack.current = false;
      if (!allowNavigation && route === 'claude' && session?.id) {
        // Restore whichever history entry the native gesture just left. This also
        // handles a stack containing earlier sessions, not only Home -> Session.
        rememberSession(session.id);
        setQuickSwitchSignal((n) => n + 1);
        return;
      }
      const id = new URLSearchParams(location.search).get('s');
      if (!id) {
        forgetSession({ updateUrl: false });
        setSession(null);
        setRoute('home');
        return;
      }
      sessionInfo(id)
        .then((s) => {
          if (!s?.id || s.alive === false) throw new Error('session unavailable');
          try { sessionStorage.setItem(ACTIVE_SESSION_KEY, String(s.id)); } catch { /* ignore */ }
          setSession(s);
          setRoute((s.kind || 'claude') === 'shell' ? 'shell' : 'claude');
        })
        .catch(() => {
          forgetSession();
          setSession(null);
          setRoute('home');
        });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [route, session]);

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
      {openingSession && (
        <div className="app-opening" role="status">
          <span className="load-spinner" /> Opening session…
        </div>
      )}
      {route === 'home' && (
        <Home
          onOpen={openSession}
          onHistory={() => setRoute('history')}
          newSessionRequested={newSessionRequested}
          onNewSessionRequestHandled={() => setNewSessionRequested(false)}
          notify={notify}
        />
      )}
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
        <SessionView
          key={session?.id}
          session={session}
          onBack={goHome}
          onOpen={openSession}
          onNewSession={() => {
            setNewSessionRequested(true);
            goHome();
          }}
          quickSwitchSignal={quickSwitchSignal}
          notify={notify}
        />
      )}
      <PlaybackControls />
    </>
  );
}
