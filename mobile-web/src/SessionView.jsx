import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, termWsUrl, sessionInfo, sessionPrompt, sayUrl, muteSession, recentSessions } from './lib/api.js';
import { ATTENTION_SHORT, isAlert } from './lib/attention.js';
import { playUrl, stopAudio, ding } from './lib/audio.js';
import { Terminal, basename } from './components.jsx';
import ChatView from './ChatView.jsx';
import ChatComposer from './ChatComposer.jsx';
import VoiceView from './VoiceView.jsx';
import TerminalKeypad from './TerminalKeypad.jsx';
import SessionSwitcher from './SessionSwitcher.jsx';
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
export default function SessionView({ session, onBack, onOpen, notify }) {
  const [state, setState] = useState(session.state || 'idle');
  const [lastReply, setLastReply] = useState(''); // for the composer's 🔊/📖 replay buttons
  const [mode, setMode] = useState('terminal'); // 'terminal' | 'chat'
  const [voice, setVoice] = useState(false); // hands-free overlay
  const [keysMode, setKeysMode] = useState(false); // terminal key-pad replaces the composer input
  const [showSwitch, setShowSwitch] = useState(false); // left session-switcher drawer
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

  // The same list the home screen and the switcher render. Two jobs here: name the
  // header exactly as the row you tapped is named, and notice when a DIFFERENT session
  // finishes, errors or hits a question — the banner below is how you hear about it
  // while you're heads-down in this one.
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let stop = false;
    const load = () => recentSessions().then((d) => !stop && setRows(d.sessions || [])).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const here = rows.find((r) => r.harnessId === session.id);
  const title = here?.name || label || basename(session.cwd);
  const alerts = rows.filter((r) => r.harnessId !== session.id && isAlert(r));

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
        const { prompt: p } = await sessionPrompt(session.id);
        if (stop) return;
        setPromptPending(!!p);
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
      sendRaw('\r');
      return;
    }
    // Slash commands drive Claude Code's own TUI menu. The prompt pipeline
    // (/api/command) mishandles that menu, so send them as raw keystrokes over
    // /ws/term (exactly like the desktop terminal): type it, then Enter once the
    // menu has filtered. The screen poll shows the result.
    ding('sent'); // immediate "it went through" cue on every send
    if (norm.startsWith('/')) {
      sendRaw(norm);
      setTimeout(() => sendRaw('\r'), 200);
      return;
    }
    runResult(commandText(session.id, norm));
  }

  // Raw-key channel for answering the TUI's interactive prompts (permission
  // dialogs, "press Enter", multi-select menus). Reuses the deployed /ws/term
  // raw transport, so Enter/arrows/Space/Esc all work without a real keyboard.
  const keyWs = useRef(null);
  useEffect(() => {
    if (mode !== 'terminal') return undefined;
    let stop = false;
    // Locking the phone suspends the tab and the OS kills this socket; without a
    // rewire, sendRaw reports "Key channel not ready" after every unlock. Reconnect
    // on close (while awake) and on the visibility flip back to foreground.
    const connect = () => {
      if (stop) return;
      const ws = new WebSocket(termWsUrl(session.id));
      keyWs.current = ws;
      ws.onclose = () => {
        if (keyWs.current === ws) keyWs.current = null;
        if (!stop && !document.hidden) setTimeout(connect, 1500);
      };
    };
    const onVisible = () => {
      if (stop || document.hidden) return;
      const ws = keyWs.current;
      if (!ws || ws.readyState > 1) connect(); // socket died while backgrounded
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      stop = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { keyWs.current?.close(); } catch { /* ignore */ }
      keyWs.current = null;
    };
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
              {VIEWS.map((v) => (
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

      {mode === 'chat' ? (
        <ChatView session={session} notify={notify} />
      ) : (
        <>
          <Terminal sessionId={session.id} className="sv-term" />
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
              busy={state === 'working…' || srvState === 'busy'}
              plainText
              allowEmptySend
              promptPending={promptPending}
              slashMode="commands"
              onKeypad={() => setKeysMode(true)}
            />
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
        </>
      )}
    </div>
  );
}
