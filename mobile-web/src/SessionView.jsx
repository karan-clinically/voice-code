import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, termWsUrl, sessionInfo, sessionPrompt, sayUrl } from './lib/api.js';
import { playUrl, stopAudio, ding } from './lib/audio.js';
import { DictationMic, Terminal, basename } from './components.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';
import SlashCommands from './SlashCommands.jsx';
import TerminalKeypad from './TerminalKeypad.jsx';
import { normalizeSpokenSlash } from './lib/slashCommands.js';

// Spoken form of a detected prompt (a numbered picker or a bash-permission dialog):
// the question followed by its numbered options, so it's clear what you're answering.
function promptSpeech(p) {
  const q = (p.question || 'Claude needs your input.').trim();
  const opts = (p.options || []).map((o) => `${o.n}. ${o.label}`).join('. ');
  return opts ? `Claude is asking: ${q}. Options: ${opts}.` : `Claude is asking: ${q}`;
}

// Prompts already spoken this app session, keyed `${sessionId}::${sig}`. Persisting
// this across SessionView mounts means navigating back to a session still sitting on
// the same question won't repeat it — but a prompt you haven't heard (a fresh mount,
// or one that changed) is announced the moment you land on the screen.
const announcedPrompts = new Set();

// Full-screen Claude session — terminal is the main view. Voice dictates into the
// command box for review; only Send reaches the pty. The conversation mode (VAD)
// code is retained in lib/audio.js but not surfaced here.
export default function SessionView({ session, onBack, notify }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);
  const [state, setState] = useState(session.state || 'idle');
  const [mode, setMode] = useState('terminal'); // 'terminal' | 'chat'
  const [voice, setVoice] = useState(false); // hands-free overlay
  const [keysMode, setKeysMode] = useState(false); // terminal key-pad replaces the composer input
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
  // The label we opened with is a snapshot and drifts as the conversation moves on
  // (Claude re-titles the session). Re-read it so the header names the session you
  // are actually in, not the one whose row you tapped.
  const [label, setLabel] = useState(session.label);
  useEffect(() => {
    setLabel(session.label);
    let stop = false;
    const pull = () => sessionInfo(session.id)
      .then((s) => { if (!stop && s?.label) setLabel(s.label); })
      .catch(() => { /* transient */ });
    pull();
    const t = setInterval(pull, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [session.id, session.label]);
  const title = 'Claude · ' + (label || basename(session.cwd));

  // Announce Claude's questions & bash-permission prompts aloud via ElevenLabs, once
  // each, on whatever view you're in. Deduped by content so a prompt that sits on
  // screen across polls is only spoken once; the ref resets when it clears.
  const promptKey = (p) =>
    session.id + '::' + (p.question || '') + '|' + (p.options || []).map((o) => o.n + o.label).join(',');
  function announcePrompt(p) {
    // Multi-part questions are answered in the terminal, not spoken. Muted (🔇) stays
    // silent — and returns BEFORE recording the prompt, so unmuting mid-question
    // announces it rather than swallowing it. Play each distinct prompt only once.
    if (!p || p.multi || !speakRef.current) return;
    const key = promptKey(p);
    if (announcedPrompts.has(key)) return;
    announcedPrompts.add(key);
    playUrl(sayUrl(promptSpeech(p)));
  }

  // Poll for a pending prompt so it's spoken even when it appears on its own (Claude
  // hitting a permission mid-task), across Terminal and Chat. Voice mode speaks
  // prompts through its own pipeline, so stand down while its overlay is open.
  useEffect(() => {
    if (voice) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const { prompt: p } = await sessionPrompt(session.id);
        if (stop) return;
        if (p) announcePrompt(p);
        // Prompt gone — forget this session's spoken prompts so a genuinely new one
        // (even with the same text) is announced again next time it appears.
        else for (const k of announcedPrompts) if (k.startsWith(session.id + '::')) announcedPrompts.delete(k);
      } catch {
        /* transient */
      }
    };
    tick();
    const t = setInterval(tick, 1800);
    return () => { stop = true; clearInterval(t); };
  }, [session.id, voice]);

  async function runResult(promise) {
    setState('working…');
    try {
      const d = await promise;
      setState('ready');
      ding('success'); // turn landed — audible even when spoken replies are muted
      // Read via the ref — the reply may land minutes after Send, and the user
      // may have muted in between. When the turn ended on a question/permission,
      // announce that (deduped) instead of the reply summary, so it isn't spoken twice.
      if (d.prompt) announcePrompt(d.prompt);
      else if (d.audioUrl && speakRef.current) playUrl(mediaUrl(d.audioUrl));
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
    if (!t) {
      // Bare Enter with nothing typed = confirm what Claude is asking on screen (a
      // numbered picker, a permission dialog, a "press Enter to continue"). Send a
      // raw carriage return to the pty instead of dropping it — the same thing the
      // ⌨ pad's Enter does — so Return alone answers a prompt without typing a number.
      sendRaw('\r');
      return;
    }
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
          {keysMode ? (
            <TerminalKeypad sendRaw={sendRaw} onClose={() => setKeysMode(false)} />
          ) : (
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
                <button type="button" className="cbtn" onClick={() => setKeysMode(true)} aria-label="Terminal keys" title="Terminal key pad — cursors, Enter, Esc, Ctrl">⌨</button>
                <button className="composer-send" onClick={() => sendText()}>Send</button>
              </div>
            </div>
          )}
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
