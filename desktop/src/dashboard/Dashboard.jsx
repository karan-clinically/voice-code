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
import { speakUrl } from '../lib/speech.js';
import { openExternal, urlPortLabel } from '../lib/open.js';
import { setTabBadge } from '../lib/tabBadge.js';
import { pickAttachments, quotePath } from '../lib/attachments.js';
import Tabs, { NewTabButton, tabName } from './Tabs.jsx';
import { clusterByFolder, folderColors, firstOfFolder, folderKey } from '../lib/folders.js';
import TerminalPane from './TerminalPane.jsx';
import ChatView from './ChatView.jsx';
import LiveLog from './LiveLog.jsx';
import HistoryOverlay from './HistoryOverlay.jsx';
import ModelPicker from './ModelPicker.jsx';
import FolderPicker from './FolderPicker.jsx';
import SessionOverview from './SessionOverview.jsx';

const TAB_ORDER_KEY = 'cvh-tab-order';
const LAST_DIR_KEY = 'cvh-last-dir';
// Terminal|Chat is one choice for the whole app: the header toggle sets it, every
// session follows it, and it is remembered per device.
const VIEW_MODE_KEY = 'cvh-view-mode';
// Served in a browser (harness /desktop) rather than inside Electron, so there is
// no native folder dialog — new sessions choose their folder in-app instead.
const SERVED = typeof window !== 'undefined' && !window.cvh;
// Session states worth flagging on the browser tab, as badge kinds.
const TAB_PING = { awaiting_input: 'input', response_ready: 'finished', failed: 'failed' };
const PING_ORDER = ['input', 'failed', 'finished'];

export default function Dashboard({ onOpenWizard }) {
  const [sessions, setSessions] = useState([]);
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMenu, setShowMenu] = useState(false); // the ☰ dropdown
  const [pickFor, setPickFor] = useState(null); // provider id awaiting a folder choice
  const [showOverview, setShowOverview] = useState(false); // all sessions, over the terminal
  const [focused, setFocused] = useState(true); // is this browser tab the one you're in?
  const [liveFeed, setLiveFeed] = useState(false); // is the /ws push socket delivering?
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(VIEW_MODE_KEY) === 'chat' ? 'chat' : 'terminal'; } catch { return 'terminal'; }
  });
  const [speak, setSpeak] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false); // mic released, text not back yet
  const [msg, setMsg] = useState('');
  const [defaultSessionDir, setDefaultSessionDir] = useState('');
  // Manual tab order (drag to reorder), persisted per device.
  const [tabOrder, setTabOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem(TAB_ORDER_KEY)) || []; } catch { return []; }
  });

  const termApis = useRef({}); // sessionId -> imperative terminal api
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
    }, setLiveFeed);
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Fallback for a socket that never opened (a proxy refusing the upgrade) or one
  // that dropped: without this the dashboard only ever refreshed on mount, so the
  // session list and every tab's state sat frozen until the page was reloaded by
  // hand. Polling stops as soon as the socket is delivering pushes again, so the
  // normal path stays push-driven rather than doing both.
  useEffect(() => {
    if (liveFeed) return undefined;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [liveFeed, refresh]);

  // Keep an active tab pointed at a live session. Tabs render in the user's
  // dragged order (unknown ids keep their arrival order — Array.sort is stable).
  const live = sessions.filter((s) => s.alive);
  const draggedOrder = [...live].sort((a, b) => {
    const ia = tabOrder.indexOf(a.id);
    const ib = tabOrder.indexOf(b.id);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
  // Several sessions on one project is the normal way to work here, so the strip
  // keeps them side by side: a folder holds the position of its first tab and its
  // later tabs join it there. Dragging still decides the order of the folders
  // themselves, and of the tabs within one.
  const orderedLive = clusterByFolder(draggedOrder);
  const tabColors = folderColors(live);
  const folderStarts = firstOfFolder(orderedLive);
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
  // A session that can't do chat (a plain shell) stays on the terminal whatever
  // the toggle says; the toggle itself keeps showing the app-wide choice.
  const modeOf = (s) => (s?.capabilities?.chat === false ? 'terminal' : viewMode);
  const setMode = (m) => {
    setViewMode(m);
    try { localStorage.setItem(VIEW_MODE_KEY, m); } catch { /* private mode */ }
  };

  // Header 📎 for the terminal view (the chat composer carries its own): put the
  // chosen files' paths at the prompt, the same thing a drop or image paste does.
  const attachToTerminal = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    try {
      const paths = await pickAttachments(id);
      const api = termApis.current[id];
      if (!paths.length) return;
      if (!api) { notify('No active terminal to attach into'); return; }
      api.write(paths.map(quotePath).join(' ') + ' ');
      api.focus();
    } catch (e) {
      notify('Attach failed: ' + e.message);
    }
  }, [notify]);
  useEffect(() => {
    if (activeId && live.some((s) => s.id === activeId)) return;
    setActiveId(orderedLive.length ? orderedLive[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  useEffect(() => {
    const sync = () => setFocused(!document.hidden && document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  // Flag waiting sessions on the Chrome tab (favicon dot + title). The session
  // you're looking at doesn't count — its state is already on screen — but every
  // session counts while this tab is in the background, which is the whole point.
  useEffect(() => {
    const waiting = live.filter((s) => TAB_PING[s.state] && !(focused && s.id === activeId));
    const kind = PING_ORDER.find((k) => waiting.some((s) => TAB_PING[s.state] === k)) || null;
    const first = waiting.find((s) => TAB_PING[s.state] === kind);
    setTabBadge({ kind, count: waiting.length, name: first ? tabName(first) : '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeId, focused]);

  async function maybeSpeak(sessionId, text) {
    if (!speakRef.current || !text) return;
    if (activeRef.current != null && sessionId !== activeRef.current) return; // active session only
    try {
      // Queued, so a reply landing mid-sentence waits its turn instead of
      // cutting the one being read off.
      speakUrl(ttsSayUrl(text));
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

  // Electron has a native folder dialog; the served dashboard browses the PC's
  // folders in-app instead (window.cvh is absent there, so asking it for a folder
  // silently produced nothing at all).
  async function newSession(kind = 'claude') {
    if (SERVED) {
      setPickFor(kind);
      return;
    }
    const dir = defaultSessionDir || await window.cvh?.pickFolder();
    if (dir) startIn(dir, kind);
  }

  async function startIn(dir, kind = 'claude') {
    try {
      const base = dir.split(/[\\/]/).filter(Boolean).pop() || 'project';
      const provider = providers.find((p) => p.id === kind);
      const label = kind === 'claude' ? null : `${base} · ${provider?.name || kind}`;
      const s = await createSession(dir, label, kind);
      try { localStorage.setItem(LAST_DIR_KEY, dir); } catch { /* private mode */ }
      setActiveId(s.id);
    } catch (e) {
      notify('Could not start session: ' + e.message);
    }
  }

  // The tailnet URL is the one worth surfacing: it works from this PC and from
  // every other device on the tailnet, which the 127.0.0.1 URL does not. Fall
  // back to local only when Tailscale exposure failed.
  const previewUrl = (p) => p?.tailscaleUrl || p?.localUrl || null;

  async function launchPreview() {
    if (!activeSession) return;
    const preview = activeSession.preview;
    if (preview?.state === 'ready') {
      openExternal(previewUrl(preview));
      return;
    }
    try {
      const result = await startSessionPreview(activeSession.id);
      setSessions((prev) => prev.map((s) => s.id === activeSession.id ? { ...s, preview: result.preview } : s));
      if (result.preview?.state === 'ready') openExternal(previewUrl(result.preview));
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

  // Colouring a tab colours its FOLDER — every live session in it, not just the
  // one you right-clicked. The strip already renders a folder as one colour, so
  // painting a single row would either look like nothing happened (another
  // session in that folder is newer and still decides the shade) or leave the
  // group disagreeing with itself the moment that session ends.
  async function setColor(id, color) {
    const target = sessions.find((s) => s.id === id);
    const key = folderKey(target?.cwd);
    const group = key ? live.filter((s) => folderKey(s.cwd) === key) : [target].filter(Boolean);
    const previous = new Map(group.map((s) => [s.id, s.tab_color || null]));
    const ids = new Set(group.map((s) => s.id));
    setSessions((prev) => prev.map((s) => (ids.has(s.id) ? { ...s, tab_color: color } : s)));
    try {
      await Promise.all(group.map((s) => setSessionColor(s.id, color)));
    } catch (e) {
      setSessions((prev) => prev.map((s) => (ids.has(s.id) ? { ...s, tab_color: previous.get(s.id) } : s)));
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
      setTranscribing(true);
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
      } finally {
        setTranscribing(false);
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
          <button
            className={'ov-btn' + (showOverview ? ' on' : '')}
            onClick={() => setShowOverview((v) => !v)}
            title={showOverview ? 'Back to the terminal' : 'All sessions'}
            aria-pressed={showOverview}
          >
            {showOverview ? '←' : '⊞'}
          </button>
          <div className="tabs-scroll">
            <Tabs
              sessions={orderedLive}
              activeId={activeId}
              onSelect={setActiveId}
              onRename={rename}
              onColor={setColor}
              onClose={close}
              onReorder={reorderTabs}
              tabColors={tabColors}
              folderStarts={folderStarts}
              providers={providers}
              // A tab already knows its folder, so its own "+" skips the folder
              // step the header's "+" needs — pick a CLI and you land in a second
              // session on the same project.
              onNewInFolder={(session, providerId) => startIn(session.cwd, providerId)}
            />
          </div>
          <NewTabButton providers={providers} onNew={newSession} />
          {activeSession && <ModelPicker session={activeSession} providers={providers} notify={notify} />}
          {activeSession && modeOf(activeSession) !== 'chat' && (
            <button
              className="hdr-btn"
              onClick={attachToTerminal}
              disabled={!activeSession.alive}
              title="Attach a file to this session (or drop a file onto the terminal, or paste an image)"
              aria-label="Attach a file"
            >
              📎
            </button>
          )}
          <div className="seg view-seg" role="group" aria-label="View" title="Show every session as the raw terminal or as a chat">
            <button
              className={'seg-btn' + (viewMode !== 'chat' ? ' on' : '')}
              onClick={() => setMode('terminal')}
              aria-pressed={viewMode !== 'chat'}
            >
              Terminal
            </button>
            <button
              className={'seg-btn' + (viewMode === 'chat' ? ' on' : '')}
              onClick={() => setMode('chat')}
              aria-pressed={viewMode === 'chat'}
            >
              Chat
            </button>
          </div>
          <div className="term-burger-wrap" ref={menuRef}>
            <button
              className={'burger-btn' + (recording ? ' rec' : '') + (transcribing ? ' stt' : '')}
              onClick={() => setShowMenu((v) => !v)}
              title={recording ? 'Menu — recording in progress' : transcribing ? 'Menu — transcribing…' : 'Menu'}
              aria-expanded={showMenu}
              aria-label="Menu"
            >
              <span className="cbtn-glyph">☰</span>
            </button>
            {showMenu && (
              <div className="burger-menu" role="menu" aria-label="Session and app options">
                {activeSession && (
                  <>
                    {activeSession.preview?.state === 'ready' && previewUrl(activeSession.preview) ? (
                      <a
                        className="burger-item on"
                        role="menuitem"
                        href={previewUrl(activeSession.preview)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={previewUrl(activeSession.preview)}
                        onClick={(e) => {
                          // Electron has no tab to open into — hand it to the OS browser.
                          if (window.cvh?.openExternal) e.preventDefault();
                          setShowMenu(false);
                          openExternal(previewUrl(activeSession.preview));
                        }}
                      >
                        ↗ Open app
                        <span className="burger-hint">
                          {activeSession.preview.tailscaleUrl
                            ? urlPortLabel(activeSession.preview.tailscaleUrl) || 'ready'
                            : 'local only'}
                        </span>
                      </a>
                    ) : (
                      <button
                        className="burger-item"
                        role="menuitem"
                        onClick={() => { setShowMenu(false); launchPreview(); }}
                        disabled={activeSession.preview?.state === 'starting'}
                        title={activeSession.preview?.error || 'Serve this project app on your tailnet'}
                      >
                        {activeSession.preview?.state === 'starting'
                          ? 'App starting…'
                          : activeSession.preview?.state === 'error'
                            ? '↻ Retry app'
                            : '▷ Start app'}
                        {activeSession.preview?.state === 'error' && <span className="burger-hint">failed</span>}
                      </button>
                    )}
                    <button
                      className={'burger-item' + (recording ? ' rec' : '') + (transcribing ? ' stt' : '')}
                      role="menuitem"
                      disabled={transcribing}
                      onClick={() => { setShowMenu(false); toggleTalk(); }}
                      title={transcribing ? 'Waiting for the transcript' : 'Dictate into the active terminal'}
                    >
                      {recording ? '● Stop listening' : transcribing ? '🎙 Transcribing…' : '🎙 Talk'}
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
                active={s.id === activeId && modeOf(s) !== 'chat'}
                onApi={registerApi}
                onWorking={markVisiblyWorking}
                notify={notify}
              />
              {modeOf(s) === 'chat' && <ChatView session={s} active={s.id === activeId} notify={notify} />}
            </React.Fragment>
          ))
        )}
        {showOverview && (
          <SessionOverview
            sessions={orderedLive}
            activeId={activeId}
            providers={providers}
            onOpen={(id) => { setActiveId(id); setShowOverview(false); }}
            onClose={() => setShowOverview(false)}
            onNew={(kind) => { setShowOverview(false); newSession(kind); }}
            onKill={close}
          />
        )}
        {showLog && (
          <div className="term-logwrap">
            <LiveLog logs={logs} />
          </div>
        )}
      </main>

      {pickFor && (
        <FolderPicker
          title={'New ' + (providers.find((p) => p.id === pickFor)?.name || pickFor) + ' session — choose a folder'}
          start={(() => {
            try { return localStorage.getItem(LAST_DIR_KEY) || defaultSessionDir; } catch { return defaultSessionDir; }
          })()}
          onPick={(dir) => { const kind = pickFor; setPickFor(null); startIn(dir, kind); }}
          onClose={() => setPickFor(null)}
          notify={notify}
        />
      )}

      {showHistory && (
        <HistoryOverlay onClose={() => setShowHistory(false)} onResume={onResumeArchive} notify={notify} />
      )}

      {msg && <div className="term-toast">{msg}</div>}
    </div>
  );
}
