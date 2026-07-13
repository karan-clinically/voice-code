import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, termWsUrl } from './lib/api.js';
import { playUrl, stopAudio, ding } from './lib/audio.js';
import { DictationMic, Terminal, basename } from './components.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';
import SlashCommands from './SlashCommands.jsx';
import { normalizeSpokenSlash } from './lib/slashCommands.js';

// Full-screen Claude session — terminal is the main view. Voice dictates into the
// command box for review; only Send reaches the pty. The conversation mode (VAD)
// code is retained in lib/audio.js but not surfaced here.
export default function SessionView({ session, onBack, notify }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);
  const [state, setState] = useState(session.state || 'idle');
  const [mode, setMode] = useState('terminal'); // 'terminal' | 'chat'
  const [voice, setVoice] = useState(false); // hands-free overlay
  const [showKeys, setShowKeys] = useState(false); // raw-key popover
  const [showCmds, setShowCmds] = useState(false); // slash-command picker
  // Speak replies aloud? Off = a normal, silent coding session. Persisted so the
  // choice sticks across sessions. TTS renders lazily on first fetch, so muting
  // also means no synthesis is billed for skipped replies.
  const [speak, setSpeak] = useState(() => localStorage.getItem('cvh_speak') !== 'off');
  const speakRef = useRef(speak);
  function toggleSpeak() {
    const next = !speak;
    setSpeak(next);
    speakRef.current = next;
    localStorage.setItem('cvh_speak', next ? 'on' : 'off');
    if (!next) stopAudio(); // cut anything mid-sentence right away
  }
  const title = 'Claude · ' + (session.label || basename(session.cwd));

  async function runResult(promise) {
    setState('working…');
    try {
      const d = await promise;
      setState('ready');
      ding('success'); // turn landed — audible even when spoken replies are muted
      // Read via the ref — the reply may land minutes after Send, and the user
      // may have muted in between.
      if (d.audioUrl && speakRef.current) playUrl(mediaUrl(d.audioUrl));
    } catch (e) {
      setState('idle');
      ding('error');
      notify(e.message);
    }
  }
  function sendText(override) {
    // Voice can't speak "/", so a dictated (or typed) "slash compact" / "forward
    // slash compact" becomes "/compact" — but only when it names a real command.
    const t = normalizeSpokenSlash((typeof override === 'string' ? override : text).trim());
    if (!t) return;
    setText('');
    // Slash commands drive Claude Code's own TUI menu. The prompt pipeline
    // (/api/command) mishandles that menu, so send them as raw keystrokes over
    // /ws/term (exactly like the desktop terminal): type it, then Enter once the
    // menu has filtered. The screen poll shows the result.
    ding('sent'); // immediate "it went through" cue on every send
    if (t.startsWith('/')) {
      sendRaw(t);
      setTimeout(() => sendRaw('\r'), 200);
      return;
    }
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

  // Picker: drop the chosen command into the box for review. 'args' commands get a
  // trailing space (cursor ready for arguments); 'menu' ones open a selector after
  // Send — the ⋯ keys then navigate it. Everything reaches the pty via Send.
  function pickCommand(c) {
    setShowCmds(false);
    setText(c.bucket === 'args' ? c.cmd + ' ' : c.cmd);
    setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); } }, 0);
  }

  // Auto-grow the command box (like the chat composer).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [text, mode]);

  const stateCls = 'sv-state' + (state === 'working…' ? ' busy' : state === 'ready' ? ' ready' : '');

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <div className="sv-title">{title}</div>
        <button
          className="ghost"
          onClick={toggleSpeak}
          title={speak ? 'Replies are read aloud — tap for a silent coding session' : 'Silent — tap to read replies aloud'}
          aria-label={speak ? 'Mute spoken replies' : 'Unmute spoken replies'}
        >
          {speak ? '🔊' : '🔇'}
        </button>
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
          <div className="composer">
            <textarea
              ref={taRef}
              className="composer-input"
              rows={1}
              enterKeyHint="send"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type a command…"
              value={text}
              onChange={(e) => {
                const v = e.target.value;
                // The phone keyboard's Enter inserts a newline (and often skips
                // keydown) — treat a trailing newline as Send.
                if (/\n$/.test(v)) sendText(v.replace(/\n+$/, ''));
                else setText(v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            <div className="composer-bar">
              <DictationMic className="cbtn" text={text} setText={setText} notify={notify} />
              <button type="button" className="cbtn" onClick={() => setShowCmds(true)} aria-label="Slash commands">/</button>
              <div className="composer-spacer" />
              <div className="sv-keymenu">
                <button type="button" className="cbtn" onClick={() => setShowKeys((v) => !v)} aria-label="Keys">⋯</button>
                {showKeys && (
                  <>
                    <div className="sv-keypop-backdrop" onClick={() => setShowKeys(false)} />
                    <div className="sv-keypop">
                      <div className="sv-keypop-title">Send a key</div>
                      <button onClick={() => sendRaw('\r')}>⏎&nbsp;&nbsp;Enter</button>
                      <button onClick={() => sendRaw('\x1b')}>⎋&nbsp;&nbsp;Esc</button>
                      <button onClick={() => sendRaw('\t')}>⇥&nbsp;&nbsp;Tab</button>
                      <button onClick={() => sendRaw(' ')}>␣&nbsp;&nbsp;Space</button>
                      <button onClick={() => sendRaw('\x1b[A')}>↑&nbsp;&nbsp;Up</button>
                      <button onClick={() => sendRaw('\x1b[B')}>↓&nbsp;&nbsp;Down</button>
                      <button onClick={() => sendRaw('\x1b[D')}>←&nbsp;&nbsp;Left</button>
                      <button onClick={() => sendRaw('\x1b[C')}>→&nbsp;&nbsp;Right</button>
                    </div>
                  </>
                )}
              </div>
              <button className="composer-send" onClick={() => sendText()}>Send</button>
            </div>
          </div>
          <div className={stateCls}>
            {state === 'working…' ? (
              <span className="sv-working">
                <span className="cw-dot" /><span className="cw-dot" /><span className="cw-dot" />
                Claude is working…
              </span>
            ) : state === 'ready' ? (
              '✓ Ready'
            ) : (
              state
            )}
          </div>
          {showCmds && <SlashCommands onPick={pickCommand} onClose={() => setShowCmds(false)} />}
        </>
      )}
    </div>
  );
}
