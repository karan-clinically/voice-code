import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  listSessions,
  createSession,
  renameSession,
  killSession,
  openWs,
  transcribeAudio,
  ttsSay,
} from '../lib/api.js';
import { startRecording } from '../lib/record.js';
import Tabs from './Tabs.jsx';
import TerminalPane from './TerminalPane.jsx';
import LiveLog from './LiveLog.jsx';

export default function Dashboard({ onOpenWizard }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState('');

  const termApis = useRef({}); // sessionId -> imperative terminal api
  const audioRef = useRef(null);
  const recRef = useRef(null);
  const speakRef = useRef(false);
  const activeRef = useRef(null);
  speakRef.current = speak;
  activeRef.current = activeId;

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

  // Keep an active tab pointed at a live session.
  const live = sessions.filter((s) => s.alive);
  useEffect(() => {
    if (activeId && live.some((s) => s.id === activeId)) return;
    setActiveId(live.length ? live[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  async function maybeSpeak(sessionId, text) {
    if (!speakRef.current || !text) return;
    if (activeRef.current != null && sessionId !== activeRef.current) return; // active session only
    try {
      const url = await ttsSay(text);
      if (audioRef.current) {
        audioRef.current.src = url;
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

  async function newSession() {
    const dir = await window.cvh?.pickFolder();
    if (!dir) return;
    try {
      const s = await createSession(dir, null);
      setActiveId(s.id);
    } catch (e) {
      notify('Could not start session: ' + e.message);
    }
  }

  async function rename(id, label) {
    setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, label } : x)));
    try {
      await renameSession(id, label);
    } catch (e) {
      notify('Rename failed: ' + e.message);
    }
  }

  async function close(id) {
    try {
      await killSession(id);
    } catch (e) {
      notify('Could not close: ' + e.message);
    }
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
        <div className="tabs-scroll">
          <Tabs
            sessions={live}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={newSession}
            onRename={rename}
            onClose={close}
          />
        </div>
        <div className="term-tools">
          <button
            className={'tool' + (recording ? ' rec' : '')}
            onClick={toggleTalk}
            title="Talk (Ctrl+`) — dictate into the active terminal"
          >
            {recording ? '● Listening…' : '🎙 Talk'}
          </button>
          <button
            className={'tool' + (speak ? ' on' : '')}
            onClick={() => setSpeak((v) => !v)}
            title="Speak Claude's replies aloud"
          >
            🔊 Speak {speak ? 'on' : 'off'}
          </button>
          <button className="tool" onClick={() => setShowLog((v) => !v)} title="Harness log">
            {showLog ? 'Hide log' : 'Log'}
          </button>
          <button className="tool" onClick={onOpenWizard} title="Settings">
            ⚙
          </button>
        </div>
      </header>

      <main className="term-main">
        {live.length === 0 ? (
          <div className="term-empty">
            <p>
              No sessions. Press <strong>+</strong> to pick a folder and launch Claude Code there — it opens as a
              live terminal tab.
            </p>
          </div>
        ) : (
          live.map((s) => (
            <TerminalPane key={s.id} session={s} active={s.id === activeId} onApi={registerApi} notify={notify} />
          ))
        )}
        {showLog && (
          <div className="term-logwrap">
            <LiveLog logs={logs} />
          </div>
        )}
      </main>

      {msg && <div className="term-toast">{msg}</div>}
      <audio ref={audioRef} hidden />
    </div>
  );
}
