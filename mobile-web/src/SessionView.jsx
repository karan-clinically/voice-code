import React, { useState } from 'react';
import { commandText, mediaUrl, sessionKey, sessionInput } from './lib/api.js';
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
  function sendText() {
    const t = text.trim();
    if (!t) return;
    setText('');
    setExpanded(false);
    runResult(commandText(session.id, t));
  }

  // Raw keys for answering the TUI's interactive prompts (permission dialogs,
  // "press Enter", menus) — the phone has no real keyboard into the pty.
  const pressEnter = () => sessionInput(session.id, '').catch((e) => notify(e.message)); // bare Enter (works now)
  const pressKey = (key) => sessionKey(session.id, key).catch(() => {}); // esc/up/down

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
            <button onClick={() => pressKey('stop')}>Esc</button>
            <button onClick={() => pressKey('up')}>↑</button>
            <button onClick={() => pressKey('down')}>↓</button>
            <button className="sv-key-enter" onClick={pressEnter}>⏎ Enter</button>
          </div>
          <div className="sv-bar">
            <DictationMic className="micbtn" text={text} setText={setText} notify={notify} />
            <textarea
              className={'sv-input' + (expanded ? ' expanded' : '')}
              rows={1}
              placeholder="Type a command…"
              value={text}
              onChange={(e) => setText(e.target.value)}
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
