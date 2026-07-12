import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, termWsUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic, Terminal, basename } from './components.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';

// Full-screen Claude session — terminal is the main view. Voice dictates into the
// command box for review; only Send reaches the pty. The conversation mode (VAD)
// code is retained in lib/audio.js but not surfaced here.
export default function SessionView({ session, onBack, notify }) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState(session.state || 'idle');
  const [mode, setMode] = useState('terminal'); // 'terminal' | 'chat'
  const [voice, setVoice] = useState(false); // hands-free overlay
  const title = 'Claude · ' + (session.label || basename(session.cwd));

  async function runResult(promise) {
    setState('working…');
    try {
      const d = await promise;
      setState('ready');
      if (d.audioUrl) playUrl(mediaUrl(d.audioUrl));
    } catch (e) {
      setState('idle');
      notify(e.message);
    }
  }
  function sendText(override) {
    const t = (typeof override === 'string' ? override : text).trim();
    if (!t) return;
    setText('');
    setExpanded(false);
    runResult(commandText(session.id, t));
  }

  // Raw-key channel for answering the TUI's interactive prompts (permission
  // dialogs, "press Enter", multi-select menus). Reuses the deployed /ws/term
  // raw transport, so Enter/arrows/Space/Esc all work without a real keyboard.
  const keyWs = useRef(null);
  useEffect(() => {
    if (mode !== 'terminal') return undefined;
    const ws = new WebSocket(termWsUrl(session.id));
    keyWs.current = ws;
    ws.onclose = () => { if (keyWs.current === ws) keyWs.current = null; };
    return () => { try { ws.close(); } catch { /* ignore */ } keyWs.current = null; };
  }, [session.id, mode]);
  const sendRaw = (seq) => {
    const ws = keyWs.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d: seq }));
    else notify('Key channel not ready — try again');
  };

  const stateCls = 'sv-state' + (state === 'working…' ? ' busy' : state === 'ready' ? ' ready' : '');

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <div className="sv-title">{title}</div>
        <button className="ghost" onClick={() => setVoice(true)} title="Hands-free voice session">🎧</button>
        <div className="seg">
          <button className={'seg-btn' + (mode !== 'chat' ? ' on' : '')} onClick={() => setMode('terminal')}>Terminal</button>
          <button className={'seg-btn' + (mode === 'chat' ? ' on' : '')} onClick={() => setMode('chat')}>Chat</button>
        </div>
      </div>

      {voice && <VoiceView session={session} onBack={() => setVoice(false)} notify={notify} />}

      {mode === 'chat' ? (
        <ChatView session={session} notify={notify} />
      ) : (
        <>
          <Terminal sessionId={session.id} className="sv-term" />
          <div className="sv-keys">
            <button onClick={() => sendRaw('\x1b')}>Esc</button>
            <button onClick={() => sendRaw('\x1b[A')}>↑</button>
            <button onClick={() => sendRaw('\x1b[B')}>↓</button>
            <button onClick={() => sendRaw(' ')} title="Toggle (multi-select)">␣</button>
            <button className="sv-key-enter" onClick={() => sendRaw('\r')}>⏎ Enter</button>
          </div>
          <div className="sv-bar">
            <DictationMic className="micbtn" text={text} setText={setText} notify={notify} />
            <textarea
              className={'sv-input' + (expanded ? ' expanded' : '')}
              rows={1}
              enterKeyHint="send"
              placeholder="Type a command…"
              value={text}
              onChange={(e) => {
                const v = e.target.value;
                // The phone keyboard's Enter inserts a newline (and often skips
                // keydown) — treat a trailing newline as Send.
                if (/\n$/.test(v)) sendText(v.replace(/\n+$/, ''));
                else setText(v);
              }}
              onFocus={() => setExpanded(true)}
              onBlur={() => !text.trim() && setExpanded(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            <button className="primary sv-send" onClick={sendText}>Send</button>
          </div>
          <div className={stateCls}>{state}</div>
        </>
      )}
    </div>
  );
}
