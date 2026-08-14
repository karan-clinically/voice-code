import React, { useEffect, useRef, useState } from 'react';
import { commandText, mediaUrl, replyUrl, termWsUrl, sessionInfo, sessionPrompt, sayUrl, muteSession, recentSessions, killSession, sessionKey, sessionKeySeq, listProviders, setSessionModel, selectPromptOption, dismissSessionAttention, startSessionPreview } from './lib/api.js';
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
import { readSessionCards, writeSessionCards, recordSessionView } from './lib/localCache.js';
import { useWakeLock, keepAwakeEnabled } from './lib/wakeLock.js';
import { listenForResume, watchReconnect } from './lib/resume.js';

// Spoken form of a detected prompt (a numbered picker or a bash-permission dialog):
// the question followed by its numbered options, so it's clear what you're answering.
function promptSpeech(p) {
  const q = (p.question || 'Please choose how Claude should proceed.').trim();
  const context = String(p.context || '').trim();
  const intro = context ? `Claude needs a decision. Here is the context: ${context}. The question is: ${q}.` : `Claude is asking: ${q}.`;
  const opts = (p.options || []).map((o) => `${o.n}. ${o.label}${o.description ? `. ${o.description}` : ''}`).join('. ');
  return opts ? `${intro} Options: ${opts}.` : intro;
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

// The hosted-app port is sticky per folder, so showing it in the menu tells the
// user which stable link this project owns (e.g. ":10444").
function previewPortLabel(url) {
  try { return ':' + new URL(url).port; } catch { return ''; }
}

// Drawer/session-card navigation intentionally passes a lightweight session
// object. Claude is model-switchable even before the detail poll hydrates the
// full capabilities object.
const supportsSessionModels = (s) =>
  s?.capabilities?.models === true || (!s?.capabilities && (!s?.kind || s.kind === 'claude'));

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
  const [terminalInputSignal, setTerminalInputSignal] = useState(0);
  const [pendingEcho, setPendingEcho] = useState(''); // just-sent command, shown until the PTY echoes it
  const [showSwitch, setShowSwitch] = useState(false); // left session-switcher drawer
  const [showQuickSwitch, setShowQuickSwitch] = useState(false); // native back-swipe Alt-Tab modal
  const [showMenu, setShowMenu] = useState(false); // ⋯ overflow: speak-replies + notifications
  const [showModels, setShowModels] = useState(false);
  const [model, setModel] = useState(session.model || 'Model');
  const [modelOptions, setModelOptions] = useState([]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelsSupported, setModelsSupported] = useState(() => supportsSessionModels(session));
  const [sessionAlive, setSessionAlive] = useState(session.alive !== false);
  const [preview, setPreview] = useState(session.preview || null);
  const [previewStarting, setPreviewStarting] = useState(false);
  // Commands parked server-side while a turn runs; sent automatically when it
  // settles, or pushed into the running turn by a second Send.
  const [queuedCmds, setQueuedCmds] = useState([]);
  useEffect(() => { recordSessionView(session.id); }, [session.id]);
  // Speak replies aloud? Off = a normal, silent coding session. Persisted so the
  // choice sticks across sessions. TTS renders lazily on first fetch, so muting
  // also means no synthesis is billed for skipped replies.
  const [speak, setSpeak] = useState(() => localStorage.getItem('cvh_speak') !== 'off');
  const speakRef = useRef(speak);
  function setSpeakerMode(next) {
    setSpeak(next);
    speakRef.current = next;
    localStorage.setItem('cvh_speak', next ? 'on' : 'off');
    if (!next) stopAudio(); // cut anything mid-sentence right away
  }
  function toggleSpeak() {
    setSpeakerMode(!speakRef.current);
  }
  // The composer speaker is both a second entry into speaker mode and an
  // immediate replay control. Turning it on reads the latest recorded assistant
  // response; turning it off cuts that replay (or any automatic reply) at once.
  function toggleSpeakerFromComposer() {
    const next = !speakRef.current;
    setSpeakerMode(next);
    if (next) playUrl(replyUrl(session.id, 'summary'));
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
    setModel(session.model || 'Model');
    setModelsSupported(supportsSessionModels(session));
    setSessionAlive(session.alive !== false);
    muteLoaded.current = false;
    let stop = false;
    const pull = () => sessionInfo(session.id)
      .then((s) => {
        if (stop) return;
        if (s?.label) setLabel(s.label);
        if (s?.state) setSrvState(s.state);
        if (s?.model) setModel(s.model);
        if (s?.capabilities) setModelsSupported(!!s.capabilities.models);
        if (typeof s?.alive === 'boolean') setSessionAlive(s.alive);
        setPreview(s?.preview || null);
        if (Array.isArray(s?.queuedCommands)) setQueuedCmds(s.queuedCommands);
        if (!muteLoaded.current && typeof s?.muted === 'boolean') {
          muteLoaded.current = true;
          setMuted(s.muted);
        }
      })
      .catch(() => { /* transient */ });
    pull();
    const t = setInterval(pull, 5000);
    const stopResume = listenForResume(pull);
    return () => { stop = true; clearInterval(t); stopResume(); };
  }, [session.id, session.label]);

  useEffect(() => {
    if (!modelsSupported) return undefined;
    let stop = false;
    listProviders()
      .then(({ providers = [] }) => {
        if (stop) return;
        const provider = providers.find((p) => p.id === (session.provider_id || session.kind || 'claude'));
        setModelOptions(provider?.models || []);
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [modelsSupported, session.kind, session.provider_id]);

  async function pickModel(option) {
    setShowModels(false);
    if (!option || isCurrentModel(option) || switchingModel) return;
    setSwitchingModel(true);
    try {
      const result = await setSessionModel(session.id, option.alias);
      setModel(result.model || option.label);
      notify?.(`Model changed to ${result.model || option.label}`, 'success');
    } catch (e) {
      notify?.('Model switch failed: ' + e.message);
    } finally {
      setSwitchingModel(false);
    }
  }
  const isCurrentModel = (option) => model === option.label || model.startsWith(option.label + ' ');
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
    const load = (force = false) => recentSessions({ force }).then((d) => {
      if (stop) return;
      const fresh = d.sessions || [];
      setRows(fresh);
      writeSessionCards(fresh);
    }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    const stopResume = listenForResume(() => load(true));
    return () => { stop = true; clearInterval(t); stopResume(); };
  }, []);
  const here = rows.find((r) => r.harnessId === session.id);
  const title = here?.name || label || basename(session.cwd);
  const alerts = rows.filter((r) => r.harnessId !== session.id && isAlert(r));
  const activeAlert = alerts[0] || null;
  const [alertPrompt, setAlertPrompt] = useState(null);
  const seenQuickSwitchSignal = useRef(quickSwitchSignal);

  useEffect(() => {
    setAlertPrompt(null);
    if (!activeAlert?.harnessId || activeAlert.attention !== 'input') return undefined;
    let stop = false;
    const pull = () => sessionPrompt(activeAlert.harnessId)
      .then(({ prompt }) => { if (!stop) setAlertPrompt(prompt || null); })
      .catch(() => {});
    pull();
    const timer = setInterval(pull, 2500);
    return () => { stop = true; clearInterval(timer); };
  }, [activeAlert?.harnessId, activeAlert?.attention]);

  const alertYes = !alertPrompt?.multi
    ? alertPrompt?.options?.find((option) => /^(yes|allow|approve)\b/i.test(option.label))
    : null;
  const alertNo = !alertPrompt?.multi
    ? alertPrompt?.options?.find((option) => /^(no|deny|reject)\b/i.test(option.label))
    : null;

  function removeAlertFromRows(id) {
    setRows((current) => {
      const next = current.map((row) => row.harnessId === id ? { ...row, attention: null } : row);
      writeSessionCards(next);
      return next;
    });
  }

  async function startPreview() {
    setShowMenu(false);
    if (previewStarting) return;
    setPreviewStarting(true);
    try {
      const result = await startSessionPreview(session.id);
      const next = result.preview || null;
      setPreview(next);
      if (!next?.tailscaleUrl || next.state === 'error') {
        throw new Error(next?.error || 'Tailscale did not return a hosted-app URL');
      }
      // Take the user straight to the app. Popup blockers may refuse an open()
      // this long after the tap; reopen the menu instead — its "Open hosted app"
      // link is a direct gesture and always works.
      const opened = window.open(next.tailscaleUrl, '_blank', 'noopener');
      if (opened) {
        notify?.('Hosted app is ready', 'success');
      } else {
        notify?.('Hosted app is ready — tap "Open hosted app"', 'success');
        setShowMenu(true);
      }
    } catch (e) {
      notify?.('Could not start app: ' + e.message);
    } finally {
      setPreviewStarting(false);
    }
  }

  async function acknowledgeAlert(id) {
    try {
      await dismissSessionAttention(id);
    } catch {
      // Compatibility with a harness process that has not restarted onto the new
      // explicit endpoint yet: reading session detail already acknowledges attention.
      await sessionInfo(id);
    }
  }

  function openAlertSession() {
    if (!activeAlert?.harnessId) return;
    // This banner is built from /recent, so it already has everything required
    // to attach to a live harness PTY. Do not gate navigation on another detail
    // fetch: after phone sleep/network handoff that request can remain frozen
    // until its AbortController fires, producing "signal is aborted" even though
    // the target session is healthy. SessionView hydrates the remaining fields in
    // its normal background poll after the switch.
    onOpen({
      id: activeAlert.harnessId,
      kind: activeAlert.shell ? 'shell' : (activeAlert.agentKind || 'claude'),
      label: activeAlert.name,
      cwd: activeAlert.cwd,
      alive: true,
      state: activeAlert.active ? 'busy' : 'idle',
    });
  }

  async function dismissAlert(e) {
    e.stopPropagation();
    if (!activeAlert?.harnessId) return;
    const id = activeAlert.harnessId;
    removeAlertFromRows(id);
    try {
      await acknowledgeAlert(id);
    } catch (err) {
      notify?.('Could not dismiss alert: ' + err.message);
    }
  }

  async function answerAlert(e, option) {
    e.stopPropagation();
    if (!activeAlert?.harnessId || !option) return;
    const id = activeAlert.harnessId;
    try {
      await selectPromptOption(id, option.n, { wait: false });
      await acknowledgeAlert(id);
      removeAlertFromRows(id);
      notify?.(`${option.label} sent to ${activeAlert.name}`, 'info');
    } catch (err) {
      notify?.('Could not answer prompt: ' + err.message);
    }
  }

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
      // A 202: the command was queued behind the running turn, or a re-send
      // pushed a queued command into it. Neither carries a reply payload — the
      // in-flight turn's own await handles completion.
      if (d.queued || d.injected) {
        setState('idle');
        ding('sent');
        if (d.queued) {
          setQueuedCmds((prev) => (prev.includes(d.transcript) ? prev : [...prev, d.transcript]));
          notify('Queued — press Send again to push it into the running turn');
        } else {
          setQueuedCmds((prev) => prev.filter((t) => t !== d.transcript));
        }
        return;
      }
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
      // "Press Enter again" with a command queued = push it into the running turn
      // now (the server injects a re-sent queued text mid-turn). A pending
      // interactive prompt takes priority — there, bare Enter must keep meaning
      // "confirm what Claude is asking".
      if (queuedCmds.length > 0 && !promptPending) {
        ding('sent');
        runResult(commandText(session.id, queuedCmds[0]));
        return;
      }
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
    // Optimistic echo: the real echo needs a full round trip (send -> PTY ->
    // repaint), so show the typed command in the view IMMEDIATELY and arm the
    // terminal's fast-repaint window so the genuine echo replaces it quickly.
    showEcho(norm);
    // Terminal-only custom CLIs do not expose a completion contract, so keep their
    // input raw. Codex advertises chat because its stabilization adapter can delimit
    // a completed turn and return the final answer for history and speech.
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

  // Pending-echo strip above the composer: visible from the moment of Send until
  // the PTY's own echo has had time to land (or the next send replaces it).
  const echoTimer = useRef(null);
  function showEcho(text) {
    clearTimeout(echoTimer.current);
    setPendingEcho(text);
    setTerminalInputSignal((n) => n + 1); // force immediate repaints while the echo lands
    echoTimer.current = setTimeout(() => setPendingEcho(''), 3500);
  }
  useEffect(() => () => clearTimeout(echoTimer.current), []);

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
    let reconnectTimer = null;
    let connectDeadline = null;
    let connectingSince = 0; // when the current handshake started (watchdog below)
    // Locking the phone suspends the tab and the OS kills this socket; without a
    // rewire, sendRaw reports "Key channel not ready" after every unlock. Reconnect
    // on close (while awake) and on the visibility flip back to foreground. The
    // ping/pong catches a ZOMBIE socket (died without a FIN, stays OPEN forever) —
    // without it, keystrokes go into the void with readyState still saying 1.
    const connect = () => {
      if (stop) return;
      const current = keyWs.current;
      if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const socket = new WebSocket(termWsUrl(session.id));
      keyWs.current = socket;
      connectingSince = Date.now();
      connectDeadline = setTimeout(() => {
        if (keyWs.current !== socket || socket.readyState === WebSocket.OPEN) return;
        keyWs.current = null;
        try { socket.close(); } catch { /* stuck handshake */ }
        if (!stop && !document.hidden && !reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 500);
        }
      }, 4000);
      socket.onopen = () => {
        if (keyWs.current !== socket) return;
        clearTimeout(connectDeadline);
        connectDeadline = null;
      };
      socket.onmessage = (e) => {
        try { if (JSON.parse(e.data).t === 'pong') { clearTimeout(pongDue); pongDue = null; } } catch { /* ignore */ }
      };
      socket.onerror = () => {
        if (keyWs.current === socket) try { socket.close(); } catch { /* onclose/deadline retries */ }
      };
      socket.onclose = () => {
        clearTimeout(pongDue); pongDue = null;
        if (keyWs.current !== socket) return;
        keyWs.current = null;
        clearTimeout(connectDeadline); connectDeadline = null;
        if (!stop && !document.hidden && !reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
        }
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
      // OPEN is not trustworthy after mobile suspension: a socket that died
      // without a FIN remains OPEN until the heartbeat eventually notices it.
      // Replace it immediately on resume so the first key works straight away.
      const stale = keyWs.current;
      keyWs.current = null;
      clearTimeout(pongDue); pongDue = null;
      clearTimeout(connectDeadline); connectDeadline = null;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      try { stale?.close(); } catch { /* already dead */ }
      connect();
    };
    const stopKeyResume = listenForResume(onVisible);
    // Same backstop as the terminal socket: the reconnects here are armed by
    // events that a waking phone can swallow, and losing the last one leaves the
    // keypad on the HTTP fallback for the rest of the session.
    const stopKeyWatchdog = watchReconnect(() => {
      if (stop) return;
      const socket = keyWs.current;
      const healthy = socket && (socket.readyState === WebSocket.OPEN
        || (socket.readyState === WebSocket.CONNECTING && Date.now() - connectingSince < 8000));
      if (healthy || reconnectTimer) return;
      if (socket) {
        keyWs.current = null;
        try { socket.close(); } catch { /* stuck handshake */ }
      }
      connect();
    });
    connect();
    return () => {
      stop = true;
      clearInterval(pinger);
      stopKeyWatchdog();
      clearTimeout(pongDue);
      clearTimeout(connectDeadline);
      clearTimeout(reconnectTimer);
      keyReconnect.current = null;
      stopKeyResume();
      try { keyWs.current?.close(); } catch { /* ignore */ }
      keyWs.current = null;
    };
  }, [session.id, mode]);
  const sendRaw = (seq, namedKey = null) => {
    // Opening the keypad changes terminal height and can make the screen look
    // scrolled-away from bottom. Tell Terminal that this is interactive input so
    // every resulting TUI redraw is shown immediately instead of after keypad exit.
    setTerminalInputSignal((value) => value + 1);
    // A healthy terminal socket is the lowest-latency path and handles every key,
    // including arrows/Esc/Enter. HTTP remains the reliable fallback after sleep,
    // restart, or a network handoff when the socket is no longer open.
    const ws = keyWs.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'in', d: seq }));
      return;
    }
    // Channel down (harness restart, zombie socket): deliver over HTTP so the
    // keystroke lands anyway, and rewire the socket for the next one.
    const fallback = namedKey ? sessionKey(session.id, namedKey) : sessionKeySeq(session.id, seq);
    fallback.catch((e) => notify('Key failed: ' + e.message));
    keyReconnect.current?.();
  };

  // `/recent` independently reports whether the PTY is active. Use it alongside
  // the detail poll so a transient/stale sessionInfo response cannot hide Stop.
  const isWorking = state === 'working…' || srvState === 'busy' || !!here?.active;
  const isReady = state === 'ready' || srvState === 'response_ready';
  // Spoken replies depend on this page staying foregrounded long enough to receive
  // the completion and start audio. Cover normal terminal/chat sends as well as the
  // hands-free overlay; previously only VoiceView held a wake lock.
  useWakeLock(keepAwakeEnabled() && speak && isWorking);
  const stateCls = 'sv-state' + (isWorking ? ' busy' : promptPending ? ' waiting' : isReady ? ' ready' : '');
  // Providers with a completion contract share the command/chat/voice pipeline.
  const viewOptions = hasChat ? VIEWS : VIEWS.filter((v) => v.id === 'terminal');

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <button className="sv-title sv-title-btn" onClick={() => setShowSwitch(true)} title="Switch session">
          <span className="sv-title-txt">{title}</span>
          <span className="sv-caret">⌄</span>
        </button>
        {modelsSupported && (
          <button
            className="sv-model-pill"
            onClick={() => { setShowMenu(false); setShowModels(true); }}
            disabled={!sessionAlive || switchingModel}
            title={`Current model: ${model}. Tap to change.`}
            aria-haspopup="dialog"
          >
            <span className="sv-model-name">{switchingModel ? 'Switching…' : model}</span>
            <span className="sv-model-caret">▾</span>
          </button>
        )}
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
              {preview?.state === 'ready' && preview.tailscaleUrl ? (
                <a
                  className="sv-menu-item sv-menu-link"
                  role="menuitem"
                  href={preview.tailscaleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowMenu(false)}
                >
                  <span className="sv-menu-ico">↗</span>
                  <span className="sv-menu-label">Open hosted app</span>
                  <span className="sv-menu-state on">{previewPortLabel(preview.tailscaleUrl) || 'Ready'}</span>
                </a>
              ) : (
                <button
                  className="sv-menu-item"
                  role="menuitem"
                  onClick={startPreview}
                  disabled={previewStarting || preview?.state === 'starting'}
                  title={preview?.error || ''}
                >
                  <span className="sv-menu-ico">{preview?.state === 'error' ? '↻' : '▷'}</span>
                  <span className="sv-menu-label">{preview?.state === 'error' ? 'Retry hosted app' : 'Start hosted app'}</span>
                  <span className="sv-menu-state">{previewStarting || preview?.state === 'starting' ? 'Starting…' : ''}</span>
                </button>
              )}
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

      {showModels && (
        <div className="sv-model-backdrop" role="presentation" onClick={() => setShowModels(false)}>
          <div className="sv-model-sheet" role="dialog" aria-modal="true" aria-labelledby="sv-model-title" onClick={(e) => e.stopPropagation()}>
            <div className="sv-model-sheet-head">
              <div>
                <div className="sv-menu-head" id="sv-model-title">Model</div>
                <strong>{model}</strong>
              </div>
              <button className="ghost sv-model-close" onClick={() => setShowModels(false)} aria-label="Close model picker">×</button>
            </div>
            <div className="sv-model-options">
              {modelOptions.map((option) => (
                <button
                  key={option.alias}
                  className={'sv-model-option' + (isCurrentModel(option) ? ' on' : '')}
                  onClick={() => pickModel(option)}
                >
                  <span>{option.label}</span>
                  {isCurrentModel(option) && <span aria-hidden="true">✓</span>}
                </button>
              ))}
              {modelOptions.length === 0 && <div className="sv-model-empty">Model choices are unavailable.</div>}
            </div>
          </div>
        </div>
      )}

      {/* Another session wants you. The banner opens that session directly; a
          binary permission can be answered in place, and every alert is dismissible. */}
      {activeAlert && (
        <div className="sv-alert" role="alert">
          <button className="sv-alert-main" onClick={openAlertSession}>
            <span className={'sv-alert-dot cc-att-' + activeAlert.attention} />
            <span className="sv-alert-txt">
              {activeAlert.name} — {ATTENTION_SHORT[activeAlert.attention].toLowerCase()}
              {alerts.length > 1 ? ` · +${alerts.length - 1} more` : ''}
            </span>
            <span className="sv-alert-go">Open ›</span>
          </button>
          <div className="sv-alert-actions">
            {alertYes && alertNo && (
              <>
                <button type="button" className="answer" onClick={(e) => answerAlert(e, alertYes)}>Yes</button>
                <button type="button" className="answer" onClick={(e) => answerAlert(e, alertNo)}>No</button>
              </>
            )}
            <button type="button" className="dismiss" onClick={dismissAlert}>Dismiss</button>
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
        <ChatView
          session={session}
          notify={notify}
          speakerOn={speak}
          onToggleSpeaker={toggleSpeakerFromComposer}
        />
      ) : (
        <>
          <Terminal
            sessionId={session.id}
            className="sv-term"
            promptPending={promptPending}
            sessionKind={session.kind}
            inputSignal={terminalInputSignal}
          />
          {pendingEcho && (
            <div className="sv-echo" role="status" aria-live="polite">
              <span className="sv-echo-prompt">❯</span>
              <span className="sv-echo-text">{pendingEcho}</span>
              <span className="sv-echo-hint">sent</span>
            </div>
          )}
          {queuedCmds.length > 0 && (
            <div className="sv-queued" role="status">
              {queuedCmds.map((t) => (
                <button
                  key={t}
                  className="sv-queued-chip"
                  title="Push into the running turn now"
                  onClick={() => runResult(commandText(session.id, t))}
                >
                  <span className="sv-queued-tag">QUEUED</span>
                  <span className="sv-queued-text">{t.length > 80 ? t.slice(0, 80) + '…' : t}</span>
                  <span className="sv-queued-now">send now</span>
                </button>
              ))}
            </div>
          )}
          {keysMode ? (
            <TerminalKeypad sendRaw={sendRaw} onClose={() => setKeysMode(false)} />
          ) : (
            <ChatComposer
              session={session}
              onSubmit={sendText}
              lastAssistantText={lastReply}
              notify={notify}
              speakerOn={speak}
              onToggleSpeaker={toggleSpeakerFromComposer}
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
