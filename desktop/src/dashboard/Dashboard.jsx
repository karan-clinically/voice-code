import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  listSessions,
  listProviders,
  createSession,
  renameSession,
  setSessionColor,
  killSession,
  openWs,
  transcribeAudio,
  ttsSayUrl,
  configState,
  startSessionPreview,
} from '../lib/api.js';
import { startRecording } from '../lib/record.js';
import Tabs, { NewTabButton } from './Tabs.jsx';
import TerminalPane from './TerminalPane.jsx';
import ChatView from './ChatView.jsx';
import LiveLog from './LiveLog.jsx';
import HistoryOverlay from './HistoryOverlay.jsx';
import ModelPicker from './ModelPicker.jsx';

const TAB_ORDER_KEY = 'cvh-tab-order';

export default function Dashboard({ onOpenWizard }) {
  const [sessions, setSessions] = useState([]);
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMenu, setShowMenu] = useState(false); // the ☰ dropdown
  const [viewModes, setViewModes] = useState({}); // sessionId -> 'terminal' | 'chat'
  const [speak, setSpeak] = useState(false);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState('');
  const [defaultSessionDir, setDefaultSessionDir] = useState('');
  // Manual tab order (drag to reorder), persisted per device.
  const [tabOrder, setTabOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem(TAB_ORDER_KEY)) || []; } catch { return []; }
  });

  const termApis = useRef({}); // sessionId -> imperative terminal api
  const audioRef = useRef(null);
  const recRef = useRef(null);
  const speakRef = useRef(false);
  const activeRef = useRef(null);
  const menuRef = useRef(null);
  speakRef.current = speak;
  activeRef.current = activeId;

  // Close the ☰ menu on any outside click.
  useEffect(() => {
    if (!showMenu) return undefined;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showMenu]);

  const notify = useCallback((m) => {
    setMsg(String(m || ''));
    if (m) setTimeout(() => setMsg(''), 4000);
  }, []);

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
    listProviders().then((d) => setProviders(d.providers || [])).catch(() => {});
    configState().then((d) => setDefaultSessionDir(d.defaultSessionDir || '')).catch(() => {});
    const ws = openWs((m) => {
      if (m.type === 'sessions') setSessions(m.sessions);
      else if (m.type === 'state')
        setSessions((prev) => prev.map((x) => (x.id === m.sessionId ? { ...x, state: m.state } : x)));
      else if (m.type === 'log') setLogs((l) => [...l.slice(-300), m]);
      else if (m.type === 'turn') maybeSpeak(m.sessionId, m.text);
    });
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Keep an active tab pointed at a live session. Tabs render in the user's
  // dragged order (unknown ids keep their arrival order — Array.sort is stable).
  const live = sessions.filter((s) => s.alive);
  const orderedLive = [...live].sort((a, b) => {
    const ia = tabOrder.indexOf(a.id);
    const ib = tabOrder.indexOf(b.id);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
  const reorderTabs = useCallback((fromId, toId) => {
    setTabOrder((prev) => {
      const ids = orderedLive.map((s) => s.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from === -1 || to === -1 || from === to) return prev;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
      return ids;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, tabOrder]);
  const activeSession = live.find((s) => s.id === activeId) || null;
  const modeOf = (id) => viewModes[id] || 'terminal';
  const activeMode = activeSession?.capabilities?.chat === false ? 'terminal' : modeOf(activeId);
  const setMode = (id, m) => setViewModes((prev) => ({ ...prev, [id]: m }));
  useEffect(() => {
    if (activeId && live.some((s) => s.id === activeId)) return;
    setActiveId(orderedLive.length ? orderedLive[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  async function maybeSpeak(sessionId, text) {
    if (!speakRef.current || !text) return;
    if (activeRef.current != null && sessionId !== activeRef.current) return; // active session only
    try {
      // Hand the URL to the element so it streams the mp3 as it renders.
      if (audioRef.current) {
        audioRef.current.src = ttsSayUrl(text);
        audioRef.current.play().catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }

  function registerApi(id, api) {
    if (api) termApis.current[id] = api;
    else delete termApis.current[id];
  }

  // The backend is authoritative for completion, but the terminal itself is the
  // fastest source for a newly-started turn (including input from Remote Control).
  // Never infer completion here; only correct a stale ready/idle state to busy.
  const markVisiblyWorking = useCallback((id) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.state !== 'busy' ? { ...s, state: 'busy', attention: null } : s)));
  }, []);

  async function newSession(kind = 'claude') {
    const dir = defaultSessionDir || await window.cvh?.pickFolder();
    if (!dir) return;
    try {
      const base = dir.split(/[\\/]/).filter(Boolean).pop() || 'project';
      const provider = providers.find((p) => p.id === kind);
      const label = kind === 'claude' ? null : `${base} · ${provider?.name || kind}`;
      const s = await createSession(dir, label, kind);
      setActiveId(s.id);
    } catch (e) {
      notify('Could not start session: ' + e.message);
    }
  }

  async function launchPreview() {
    if (!activeSession) return;
    const preview = activeSession.preview;
    if (preview?.state === 'ready') {
      const url = preview.localUrl || preview.tailscaleUrl;
      if (url) await window.cvh?.openExternal(url);
      return;
    }
    try {
      const result = await startSessionPreview(activeSession.id);
      setSessions((prev) => prev.map((s) => s.id === activeSession.id ? { ...s, preview: result.preview } : s));
      if (result.preview?.state === 'ready' && result.preview.localUrl) {
        await window.cvh?.openExternal(result.preview.localUrl);
      }
    } catch (e) {
      notify('Could not start app: ' + e.message);
    }
  }

  async function rename(id, label) {
    setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, label } : x)));
    try {
      const result = await renameSession(id, label);
      if (result.kind === 'claude' && result.alive && !result.claudeSynced) {
        notify('Tab renamed, but Claude title sync failed' + (result.syncError ? ': ' + result.syncError : ''));
      }
    } catch (e) {
      notify('Rename failed: ' + e.message);
    }
  }

  async function setColor(id, color) {
    const previous = sessions.find((s) => s.id === id)?.tab_color || null;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, tab_color: color } : s)));
    try {
      await setSessionColor(id, color);
    } catch (e) {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, tab_color: previous } : s)));
      notify('Tab color failed: ' + e.message);
    }
  }

  async function close(id) {
    try {
      await killSession(id);
    } catch (e) {
      notify('Could not close: ' + e.message);
    }
  }

  // A resumed archive session comes back live — add it optimistically (so the
  // keep-active effect doesn't bounce off it before the WS list catches up),
  // focus its tab, and close the drawer.
  function onResumeArchive(session) {
    setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
    setActiveId(session.id);
    setShowHistory(false);
    notify('Resumed “' + (session.label || session.id) + '”');
  }

  // Push-to-talk: record → transcribe (cleaned) → drop text at the prompt for
  // review (no Enter). Toggle with the button or Ctrl+`.
  const toggleTalk = useCallback(async () => {
    if (recRef.current) {
      const handle = recRef.current;
      recRef.current = null;
      setRecording(false);
      try {
        const blob = await handle.stop();
        const { text } = await transcribeAudio(blob, 'webm', { cleanup: true });
        const api = termApis.current[activeRef.current];
        if (text && api) {
          api.write(text);
          api.focus();
        } else if (!api) {
          notify('No active terminal to dictate into');
        }
      } catch (e) {
        notify('Voice input failed: ' + e.message);
      }
      return;
    }
    try {
      recRef.current = await startRecording();
      setRecording(true);
    } catch {
      notify('Microphone unavailable');
    }
  }, [notify]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        toggleTalk();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleTalk]);

  return (
    <div className="term-app">
      <header className="term-topbar">
        <div className="term-tabs-row">
          <div className="tabs-scroll">
            <Tabs
              sessions={orderedLive}
              activeId={activeId}
              onSelect={setActiveId}
              onRename={rename}
              onColor={setColor}
              onClose={close}
              onReorder={reorderTabs}
            />
          </div>
          <NewTabButton providers={providers} onNew={newSession} />
          <div className="term-burger-wrap" ref={menuRef}>
            <button
              className={'burger-btn' + (recording ? ' rec' : '')}
              onClick={() => setShowMenu((v) => !v)}
              title={recording ? 'Menu — recording in progress' : 'Menu'}
              aria-expanded={showMenu}
              aria-label="Menu"
            >
              ☰
            </button>
            {showMenu && (
              <div className="burger-menu" role="menu" aria-label="Session and app options">
                {activeSession && (
                  <>
                    {activeSession.capabilities?.chat !== false && (
                      <div className="burger-row seg" title="Switch the active session between the raw terminal and a chat view">
                        <button
                          className={'seg-btn' + (activeMode !== 'chat' ? ' on' : '')}
                          onClick={() => setMode(activeId, 'terminal')}
                        >
                          Terminal
                        </button>
                        <button
                          className={'seg-btn' + (activeMode === 'chat' ? ' on' : '')}
                          onClick={() => setMode(activeId, 'chat')}
                        >
                          Chat
                        </button>
                      </div>
                    )}
                    <div className="burger-row">
                      <ModelPicker session={activeSession} notify={notify} />
                    </div>
                    <button
                      className={'burger-item' + (activeSession.preview?.state === 'ready' ? ' on' : '')}
                      role="menuitem"
                      onClick={() => { setShowMenu(false); launchPreview(); }}
                      disabled={activeSession.preview?.state === 'starting'}
                      title={activeSession.preview?.error || 'Open this project app in your browser'}
                    >
                      {activeSession.preview?.state === 'starting'
                        ? 'App starting…'
                        : activeSession.preview?.state === 'ready'
                          ? '↗ Open app'
                          : activeSession.preview?.state === 'error'
                            ? '↻ Retry app'
                            : '▷ Start app'}
                    </button>
                    <button
                      className={'burger-item' + (recording ? ' rec' : '')}
                      role="menuitem"
                      onClick={() => { setShowMenu(false); toggleTalk(); }}
                      title="Dictate into the active terminal"
                    >
                      {recording ? '● Stop listening' : '🎙 Talk'}
                      <span className="burger-hint">Ctrl+`</span>
                    </button>
                    <button
                      className={'burger-item' + (speak ? ' on' : '')}
                      role="menuitem"
                      onClick={() => setSpeak((v) => !v)}
                      title="Speak replies from the active session aloud"
                    >
                      🔊 Speak replies
                      <span className="burger-hint">{speak ? 'on' : 'off'}</span>
                    </button>
                    <div className="burger-sep" />
                  </>
                )}
                <button className="burger-item" role="menuitem" onClick={() => { setShowMenu(false); setShowHistory(true); }} title="Search & resume past sessions">
                  🕘 History
                </button>
                <button className={'burger-item' + (showLog ? ' on' : '')} role="menuitem" onClick={() => { setShowMenu(false); setShowLog((v) => !v); }} title="Harness log">
                  {showLog ? 'Hide log' : 'Log'}
                </button>
                <button className="burger-item" role="menuitem" onClick={() => { setShowMenu(false); onOpenWizard(); }} title="Settings">
                  ⚙ Settings
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="term-main">
        {live.length === 0 ? (
          <div className="term-empty">
            <p>
              No sessions. Press <strong>+</strong> to pick a folder and launch an installed AI CLI.
            </p>
          </div>
        ) : (
          live.map((s) => (
            <React.Fragment key={s.id}>
              {/* Terminal stays mounted so the PTY/scrollback survive the toggle;
                  it just hides under the chat overlay in chat mode. */}
              <TerminalPane
                session={s}
                active={s.id === activeId && (s.capabilities?.chat === false || modeOf(s.id) !== 'chat')}
                onApi={registerApi}
                onWorking={markVisiblyWorking}
                notify={notify}
              />
              {s.capabilities?.chat !== false && modeOf(s.id) === 'chat' && <ChatView session={s} active={s.id === activeId} notify={notify} />}
            </React.Fragment>
          ))
        )}
        {showLog && (
          <div className="term-logwrap">
            <LiveLog logs={logs} />
          </div>
        )}
      </main>

      {showHistory && (
        <HistoryOverlay onClose={() => setShowHistory(false)} onResume={onResumeArchive} notify={notify} />
      )}

      {msg && <div className="term-toast">{msg}</div>}
      <audio ref={audioRef} hidden />
    </div>
  );
}
