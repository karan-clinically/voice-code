import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, termWsUrl, sessionInfo, sessionPrompt, sayUrl, muteSession, recentSessions, killSession, sessionKey, sessionKeySeq } from './lib/api.js';
import { ATTENTION_SHORT, isAlert } from './lib/attention.js';
import { playUrl, stopAudio, ding } from './lib/audio.js';
import { Terminal, basename } from './components.jsx';
import ChatView from './ChatView.jsx';
import ChatComposer from './ChatComposer.jsx';
import VoiceView from './VoiceView.jsx';
import TerminalKeypad from './TerminalKeypad.jsx';
import SessionSwitcher from './SessionSwitcher.jsx';
import QuickSessionSwitcher from './QuickSessionSwitcher.jsx';
import { normalizeSpokenSlash } from './lib/slashCommands.js';
import { readSessionCards, writeSessionCards } from './lib/localCache.js';

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

// The three ways to drive a session, picked from the ⋯ menu. Voice is an overlay on
// top of whichever of the other two you were last in, so leaving it drops you back.
const VIEWS = [
  { id: 'terminal', label: 'Terminal', ico: '▮' },
  { id: 'chat', label: 'Chat', ico: '💬' },
  { id: 'voice', label: 'Voice (hands-free)', ico: '🎧' },
];

// Full-screen Claude session — terminal is the main view. Voice dictates into the
// command box for review; only Send reaches the pty. The conversation mode (VAD)
// code is retained in lib/audio.js but not surfaced here.
export default function SessionView({ session, onBack, onOpen, onNewSession, quickSwitchSignal = 0, notify }) {
  const isGrok = (session.kind || '') === 'grok';
  const isCodex = (session.kind || '') === 'codex';
  const hasChat = session.capabilities?.chat !== false;
  const [state, setState] = useState(session.state || 'idle');
  const [lastReply, setLastReply] = useState(''); // for the composer's 🔊/📖 replay buttons
  const [mode, setMode] = useState('terminal'); // 'terminal' | 'chat'
  const [voice, setVoice] = useState(false); // hands-free overlay
  const [keysMode, setKeysMode] = useState(false); // terminal key-pad replaces the composer input
  const [showSwitch, setShowSwitch] = useState(false); // left session-switcher drawer
  const [showQuickSwitch, setShowQuickSwitch] = useState(false); // native back-swipe Alt-Tab modal
  const [showMenu, setShowMenu] = useState(false); // ⋯ overflow: speak-replies + notifications
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
  // Whether phone push for THIS session is silenced. Loaded once from the server
  // (it is persisted there); the toggle owns it after that, so the 5s poll can't
  // clobber an optimistic flip.
  const [muted, setMuted] = useState(false);
  const muteLoaded = useRef(false);
  // A question/permission dialog is on screen right now (from the prompt poll below).
  // The composer needs it: mid-question the session still reads as busy, but its
  // button must offer Enter (answer) rather than Esc (interrupt).
  const [promptPending, setPromptPending] = useState(false);
  const [terminalActivity, setTerminalActivity] = useState(null);
  // The session is now shared — the terminal or Claude remote control can start a turn
  // this view never saw. The local `state` below only tracks turns THIS phone sent, so
  // without the server's own state the ■ Stop button would never appear for a turn
  // driven from elsewhere, leaving no way to interrupt it from the phone.
  const [srvState, setSrvState] = useState(session.state || 'idle');
  useEffect(() => {
    setLabel(session.label);
    muteLoaded.current = false;
    let stop = false;
    const pull = () => sessionInfo(session.id)
      .then((s) => {
        if (stop) return;
        if (s?.label) setLabel(s.label);
        if (s?.state) setSrvState(s.state);
        if (!muteLoaded.current && typeof s?.muted === 'boolean') {
          muteLoaded.current = true;
          setMuted(s.muted);
        }
      })
      .catch(() => { /* transient */ });
    pull();
    const t = setInterval(pull, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [session.id, session.label]);
  async function toggleMute() {
    const next = !muted;
    setMuted(next); // optimistic
    try {
      const r = await muteSession(session.id, next);
      setMuted(!!r.muted);
    } catch (e) {
      setMuted(!next);
      notify?.(e.message);
    }
  }

  async function endSession() {
    setShowMenu(false);
    const name = title || label || basename(session.cwd) || `Session ${session.id}`;
    if (!window.confirm(`End "${name}"?\n\nThis stops the session everywhere — phone, desktop terminal, and any attached agent process.`)) return;
    try {
      await killSession(session.id);
      stopAudio();
      onBack();
    } catch (e) {
      notify?.('End session failed: ' + e.message);
    }
  }

  // The same list the home screen and the switcher render. Two jobs here: name the
  // header exactly as the row you tapped is named, and notice when a DIFFERENT session
  // finishes, errors or hits a question — the banner below is how you hear about it
  // while you're heads-down in this one.
  const [rows, setRows] = useState(readSessionCards);
  useEffect(() => {
    let stop = false;
    const load = () => recentSessions().then((d) => {
      if (stop) return;
      const fresh = d.sessions || [];
      setRows(fresh);
      writeSessionCards(fresh);
    }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const here = rows.find((r) => r.harnessId === session.id);
  const title = here?.name || label || basename(session.cwd);
  const alerts = rows.filter((r) => r.harnessId !== session.id && isAlert(r));
  const seenQuickSwitchSignal = useRef(quickSwitchSignal);

  useEffect(() => {
    if (quickSwitchSignal > seenQuickSwitchSignal.current) {
      seenQuickSwitchSignal.current = quickSwitchSignal;
      setShowMenu(false);
      setShowSwitch(false);
      setShowQuickSwitch(true);
    }
  }, [quickSwitchSignal]);

  const view = voice ? 'voice' : mode;
  function pickView(id) {
    setShowMenu(false);
    setVoice(id === 'voice');
    if (id !== 'voice') setMode(id);
  }

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
        const { prompt: p, activity = null } = await sessionPrompt(session.id);
        if (stop) return;
        setPromptPending(!!p);
        setTerminalActivity(activity);
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

  async function handleTerminalActivity(key) {
    try {
      await sessionKey(session.id, key);
      setTerminalActivity(null);
      if (key === 'background') notify?.('Shell commands moved to the background', 'info');
      else notify?.('Stop sent to the foreground command', 'info');
    } catch (e) {
      notify?.('Terminal action failed: ' + e.message);
    }
  }

  async function runResult(promise) {
    setState('working…');
    try {
      const d = await promise;
      setState('ready');
      ding('success'); // turn landed — audible even when spoken replies are muted
      if (d.responseText) setLastReply(d.responseText);
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
  function sendText(t) {
    // Voice can't speak "/", so a dictated (or typed) "slash compact" / "forward
    // slash compact" becomes "/compact" — but only when it names a real command.
    const norm = normalizeSpokenSlash((t || '').trim());
    if (!norm) {
      // Bare Enter with nothing typed = confirm what Claude is asking on screen (a
      // numbered picker, a permission dialog, a "press Enter to continue"). Send a
      // raw carriage return to the pty instead of dropping it — the same thing the
      // ⌨ pad's Enter does — so Return alone answers a prompt without typing a number.
      //
      // Tapping it TWICE quickly accepts Claude's ghosted next-prompt suggestion:
      // the TUI only materialises a suggestion on Tab (a bare Enter is a no-op with
      // ghost text showing), so the second tap sends Tab-then-Enter. The first
      // tap's stray Enter is harmless in that state, and prompt-confirmation still
      // works because nobody double-taps a prompt they just confirmed.
      const now = Date.now();
      if (now - lastEmptySend.current < 600) {
        lastEmptySend.current = 0;
        ding('sent');
        sendRaw('\t');
        setTimeout(() => sendRaw('\r'), 150);
        return;
      }
      lastEmptySend.current = now;
      sendRaw('\r');
      return;
    }
    // Codex is an interactive terminal app; until we add a Codex-specific
    // completion parser/hook, send everything as raw terminal input and keep the
    // phone attached to the live PTY.
    if (!hasChat) {
      ding('sent');
      sendRaw(norm);
      setTimeout(() => sendRaw('\r'), 120);
      return;
    }
    // Grok local slash commands (/help, /cwd, /exit) stay in the agent REPL.
    // Everything else goes through /api/command so completion, chat log, TTS and
    // push notifications work the same as Claude.
    if (isGrok && /^\/(help|cwd|exit|quit)\b/i.test(norm)) {
      ding('sent');
      sendRaw(norm);
      setTimeout(() => sendRaw('\r'), 120);
      return;
    }
    // Slash commands drive Claude Code's own TUI menu. The prompt pipeline
    // (/api/command) mishandles that menu, so send them as raw keystrokes over
    // /ws/term (exactly like the desktop terminal): type it, then Enter once the
    // menu has filtered. The screen poll shows the result.
    ding('sent'); // immediate "it went through" cue on every send
    if (!isGrok && norm.startsWith('/')) {
      sendRaw(norm);
      setTimeout(() => sendRaw('\r'), 200);
      return;
    }
    runResult(commandText(session.id, norm));
  }

  // Raw-key channel for answering the TUI's interactive prompts (permission
  // dialogs, "press Enter", multi-select menus). Reuses the deployed /ws/term
  // raw transport, so Enter/arrows/Space/Esc all work without a real keyboard.
  const lastEmptySend = useRef(0); // double-tap-Send window for accepting a suggested prompt
  const keyWs = useRef(null);
  const keyReconnect = useRef(null); // set by the effect; sendRaw uses it to rewire after a fallback
  useEffect(() => {
    if (mode !== 'terminal') return undefined;
    let stop = false;
    let pongDue = null;
    // Locking the phone suspends the tab and the OS kills this socket; without a
    // rewire, sendRaw reports "Key channel not ready" after every unlock. Reconnect
    // on close (while awake) and on the visibility flip back to foreground. The
    // ping/pong catches a ZOMBIE socket (died without a FIN, stays OPEN forever) —
    // without it, keystrokes go into the void with readyState still saying 1.
    const connect = () => {
      if (stop) return;
      const ws = new WebSocket(termWsUrl(session.id));
      keyWs.current = ws;
      ws.onmessage = (e) => {
        try { if (JSON.parse(e.data).t === 'pong') { clearTimeout(pongDue); pongDue = null; } } catch { /* ignore */ }
      };
      ws.onclose = () => {
        clearTimeout(pongDue); pongDue = null;
        if (keyWs.current === ws) keyWs.current = null;
        if (!stop && !document.hidden) setTimeout(connect, 1500);
      };
    };
    keyReconnect.current = connect;
    const pinger = setInterval(() => {
      const ws = keyWs.current;
      if (stop || document.hidden || !ws || ws.readyState !== 1 || pongDue) return;
      try { ws.send(JSON.stringify({ t: 'ping' })); } catch { return; }
      pongDue = setTimeout(() => { pongDue = null; try { ws.close(); } catch { /* dead */ } }, 8000);
    }, 20000);
    const onVisible = () => {
      if (stop || document.hidden) return;
      const ws = keyWs.current;
      if (!ws || ws.readyState > 1) connect(); // socket died while backgrounded
    };
    document.addEventListener('visibilitychange', onVisible);
    // iOS bfcache restores can fire pageshow with no visibilitychange.
    window.addEventListener('pageshow', onVisible);
    connect();
    return () => {
      stop = true;
      clearInterval(pinger);
      clearTimeout(pongDue);
      keyReconnect.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      try { keyWs.current?.close(); } catch { /* ignore */ }
      keyWs.current = null;
    };
  }, [session.id, mode]);
  const sendRaw = (seq, namedKey = null) => {
    // The server's allowlisted key endpoint is more reliable for navigation keys
    // than a browser socket after a phone sleep/network handoff: a zombie WebSocket
    // can still report OPEN while silently dropping writes. Use HTTP directly for
    // arrows/Esc/Enter; raw-only keys continue over the terminal socket.
    if (namedKey) {
      sessionKey(session.id, namedKey).catch((e) => notify('Key failed: ' + e.message));
      return;
    }
    const ws = keyWs.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'in', d: seq }));
      return;
    }
    // Channel down (harness restart, zombie socket): deliver over HTTP so the
    // keystroke lands anyway, and rewire the socket for the next one.
    sessionKeySeq(session.id, seq).catch((e) => notify('Key failed: ' + e.message));
    keyReconnect.current?.();
  };

  // `/recent` independently reports whether the PTY is active. Use it alongside
  // the detail poll so a transient/stale sessionInfo response cannot hide Stop.
  const isWorking = state === 'working…' || srvState === 'busy' || !!here?.active || terminalActivity?.kind === 'foreground-shell';
  const isReady = state === 'ready' || srvState === 'response_ready';
  const stateCls = 'sv-state' + (isWorking ? ' busy' : promptPending ? ' waiting' : isReady ? ' ready' : '');
  // Grok shares the command/chat/voice pipeline as Claude (turn-complete hook).
  // Codex is terminal-first for now: no chat/voice views until we add a Codex
  // completion hook/parser.
  const viewOptions = hasChat ? VIEWS : VIEWS.filter((v) => v.id === 'terminal');

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <button className="sv-title sv-title-btn" onClick={() => setShowSwitch(true)} title="Switch session">
          <span className="sv-title-txt">{title}</span>
          <span className="sv-caret">⌄</span>
        </button>
        {/* One ⋯ owns the whole bar: which of the three views you're in, plus the two
            on/off settings. Keeps the top bar to back · title · ⋯ on a narrow phone. */}
        <button
          className="ghost sv-more"
          onClick={() => setShowMenu((v) => !v)}
          aria-label="View and options"
          aria-expanded={showMenu}
        >
          ⋯
        </button>

        {showMenu && (
          <>
            <div className="sv-menu-backdrop" onClick={() => setShowMenu(false)} />
            <div className="sv-menu" role="menu">
              <div className="sv-menu-head">View</div>
              {viewOptions.map((v) => (
                <button
                  key={v.id}
                  className="sv-menu-item"
                  role="menuitemradio"
                  aria-checked={view === v.id}
                  onClick={() => pickView(v.id)}
                >
                  <span className="sv-menu-ico">{v.ico}</span>
                  <span className="sv-menu-label">{v.label}</span>
                  {view === v.id && <span className="sv-menu-state on">✓</span>}
                </button>
              ))}
              <div className="sv-menu-sep" />
              <button className="sv-menu-item" role="menuitemcheckbox" aria-checked={speak} onClick={toggleSpeak}>
                <span className="sv-menu-ico">{speak ? '🔊' : '🔇'}</span>
                <span className="sv-menu-label">Speak replies</span>
                <span className={'sv-menu-state' + (speak ? ' on' : '')}>{speak ? 'On' : 'Off'}</span>
              </button>
              <button className="sv-menu-item" role="menuitemcheckbox" aria-checked={!muted} onClick={toggleMute}>
                <span className="sv-menu-ico">{muted ? '🔕' : '🔔'}</span>
                <span className="sv-menu-label">Notifications</span>
                <span className={'sv-menu-state' + (!muted ? ' on' : '')}>{muted ? 'Off' : 'On'}</span>
              </button>
              <div className="sv-menu-sep" />
              <button className="sv-menu-item" role="menuitem" onClick={endSession}>
                <span className="sv-menu-ico">🛑</span>
                <span className="sv-menu-label">End session</span>
                <span className="sv-menu-state">Kill</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Another session wants you — it finished, errored, or is sitting on a question.
          Tapping opens the switcher so you can go straight to it. */}
      {alerts.length > 0 && (
        <button className="sv-alert" onClick={() => setShowSwitch(true)}>
          <span className={'sv-alert-dot cc-att-' + alerts[0].attention} />
          <span className="sv-alert-txt">
            {alerts.length === 1
              ? `${alerts[0].name} — ${ATTENTION_SHORT[alerts[0].attention].toLowerCase()}`
              : `${alerts.length} other sessions want you`}
          </span>
          <span className="sv-alert-go">Switch ›</span>
        </button>
      )}

      {terminalActivity && !promptPending && (
        <div className={'sv-terminal-activity ' + terminalActivity.kind} role="alert">
          <div className="sv-terminal-activity-copy">
            <strong>{terminalActivity.title}</strong>
            <span>{terminalActivity.detail}</span>
          </div>
          <div className="sv-terminal-activity-actions">
            {terminalActivity.canBackground && (
              <button type="button" onClick={() => handleTerminalActivity('background')}>Run in background</button>
            )}
            {terminalActivity.canStop && (
              <button type="button" className="danger" onClick={() => handleTerminalActivity('stop')}>Stop</button>
            )}
          </div>
        </div>
      )}

      {voice && <VoiceView session={session} onBack={() => setVoice(false)} notify={notify} />}

      {showSwitch && (
        <SessionSwitcher
          session={session}
          onOpen={onOpen}
          onClose={() => setShowSwitch(false)}
          onHome={onBack}
          notify={notify}
        />
      )}

      {showQuickSwitch && (
        <QuickSessionSwitcher
          key={quickSwitchSignal}
          session={session}
          rows={rows}
          onOpen={onOpen}
          onNew={onNewSession}
          onClose={() => setShowQuickSwitch(false)}
          notify={notify}
        />
      )}

      {hasChat && mode === 'chat' ? (
        <ChatView session={session} notify={notify} />
      ) : (
        <>
          <Terminal sessionId={session.id} className="sv-term" promptPending={promptPending} />
          {keysMode ? (
            <TerminalKeypad sendRaw={sendRaw} onClose={() => setKeysMode(false)} />
          ) : (
            <ChatComposer
              session={session}
              onSubmit={sendText}
              lastAssistantText={lastReply}
              notify={notify}
              // Busy = a turn this phone sent (instant) OR one the server reports from
              // any other driver (terminal / remote control). `session.state` alone is
              // a snapshot from when the view opened and never flips, so relying on it
              // meant the send button could never become ■ Stop.
              busy={isWorking}
              plainText
              allowEmptySend
              promptPending={promptPending}
              slashMode="commands"
              onKeypad={() => setKeysMode(true)}
            />
          )}
          <div className={stateCls}>
            {promptPending ? (
              <span className="sv-working">● Waiting for your input</span>
            ) : isWorking ? (
              <span className="sv-working">
                <span className="cw-dot" /><span className="cw-dot" /><span className="cw-dot" />
                {isCodex ? 'Codex is working…' : isGrok ? 'Grok is working…' : 'Claude is working…'}
              </span>
            ) : isReady ? (
              '✓ Ready'
            ) : (
              'Connected · idle'
            )}
          </div>
        </>
      )}
    </div>
  );
}
