import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionScreen, sessionResize, termWsUrl, fsList, getSttMode, setSttMode, getSettings, saveSettings, listElevenVoices, sayUrl } from './lib/api.js';
import { tapRecord, playUrl } from './lib/audio.js';
import { useDictation } from './lib/dictation.js';

export const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

// Dictation mic bound to a text box: the transcript lands in `text` for review
// and is NEVER sent — the caller's Send/Run button is the only way to the pty.
// In stream mode the words appear live while speaking.
export function DictationMic({ className, text, setText, notify }) {
  const { recording, tidying, toggle } = useDictation({ text, setText, notify });
  return (
    <button
      type="button"
      className={(className || 'micbtn') + (recording ? ' rec' : '') + (tidying ? ' tidying' : '')}
      onClick={toggle}
      disabled={tidying}
      title={recording ? 'Tap to stop' : tidying ? 'Tidying up what you said…' : 'Tap to talk'}
    >
      {tidying ? '✨' : '🎙️'}
    </button>
  );
}

// Quick batch|stream toggle. Shared with the desktop (persisted harness-side).
export function SttModeToggle({ notify }) {
  const [mode, setMode] = useState('batch');
  useEffect(() => {
    getSttMode().then(setMode).catch(() => {});
  }, []);
  const choose = async (m) => {
    const prev = mode;
    setMode(m); // optimistic
    try {
      await setSttMode(m);
    } catch (e) {
      setMode(prev);
      notify?.(e.message);
    }
  };
  return (
    <div className="seg" title="How voice reaches the box — nothing sends until you tap Send">
      <button className={'seg-btn' + (mode !== 'stream' ? ' on' : '')} onClick={() => choose('batch')}>
        Batch
      </button>
      <button className={'seg-btn' + (mode === 'stream' ? ' on' : '')} onClick={() => choose('stream')}>
        Live
      </button>
    </div>
  );
}

// Summarise dictation: off = light cleanup (near-verbatim), on = condense
// rambling speech into a tight instruction (keeps file names/paths/code). Shared
// harness-side via /api/settings, so it applies to phone + desktop dictation.
export function SummariseToggle({ notify }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    getSettings().then((s) => setOn(s.dictation_summarise === 'on')).catch(() => {});
  }, []);
  const choose = async (want) => {
    if (want === on) return;
    setOn(want); // optimistic
    try {
      await saveSettings({ dictation_summarise: want ? 'on' : 'off' });
    } catch (e) {
      setOn(!want);
      notify?.(e.message);
    }
  };
  return (
    <div className="seg" title="How much your speech is rewritten before it lands in the box">
      <button className={'seg-btn' + (!on ? ' on' : '')} onClick={() => choose(false)}>Clean up</button>
      <button className={'seg-btn' + (on ? ' on' : '')} onClick={() => choose(true)}>Summarise</button>
    </div>
  );
}

// ElevenLabs voice picker. Voice is the only speech choice now — Deepgram was
// dropped (its Aura-2 renders at ~1x realtime, too slow for hands-free). On load
// it also pins the provider to ElevenLabs so nothing can drift back to Deepgram.
// The API key never reaches the phone; it only sees voice names/ids.
export function ElevenVoicePicker({ notify }) {
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const s = await getSettings();
        if (!s.elevenlabs_available) {
          if (!stop) { setAvailable(false); setLoading(false); }
          return;
        }
        if (!stop) setVoiceId(s.elevenlabs_voice_id || '');
        // Lock speech to ElevenLabs (Deepgram removed from the UI).
        if (s.stt_provider !== 'elevenlabs' || s.tts_provider !== 'elevenlabs') {
          saveSettings({ stt_provider: 'elevenlabs', tts_provider: 'elevenlabs' }).catch(() => {});
        }
        const d = await listElevenVoices();
        if (!stop) { setVoices(d.voices || []); setLoading(false); }
      } catch (e) {
        if (!stop) { setLoading(false); notify?.(e.message); }
      }
    })();
    return () => { stop = true; };
  }, []);

  const choose = async (id) => {
    const prev = voiceId;
    setVoiceId(id); // optimistic
    try {
      await saveSettings({ elevenlabs_voice_id: id });
    } catch (e) {
      setVoiceId(prev);
      notify?.(e.message);
    }
  };

  const preview = async () => {
    if (!voiceId || previewing) return;
    setPreviewing(true);
    try {
      await playUrl(sayUrl('Hi, this is how I sound reading your replies.', voiceId));
    } catch (e) {
      notify?.(e.message);
    }
    setPreviewing(false);
  };

  if (!available) {
    return <div className="muted">Add an ElevenLabs API key on the PC to choose a voice.</div>;
  }
  // A saved custom voice might not be in the fetched list — keep it selectable.
  const hasCurrent = voices.some((v) => v.voice_id === voiceId);
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      <select value={voiceId} onChange={(e) => choose(e.target.value)} disabled={loading} style={{ flex: 1 }}>
        {loading && <option value="">Loading voices…</option>}
        {!loading && voices.length === 0 && <option value="">No voices found</option>}
        {!loading && voiceId && !hasCurrent && <option value={voiceId}>Current voice</option>}
        {voices.map((v) => (
          <option key={v.voice_id} value={v.voice_id}>
            {v.name}{v.category ? ` · ${v.category}` : ''}
          </option>
        ))}
      </select>
      <button type="button" onClick={preview} disabled={!voiceId || previewing} title="Hear this voice" style={{ flex: '0 0 auto' }}>
        {previewing ? '▶…' : '▶ Preview'}
      </button>
    </div>
  );
}

// Tap-to-talk mic. onBlob(blob, ext) receives the recording; caller decides what
// to do (transcribe, or send as a command).
export function MicButton({ className, onBlob, notify }) {
  const [rec, setRec] = useState(null);
  async function toggle() {
    if (rec) {
      rec.stop();
      setRec(null);
      return;
    }
    const h = await tapRecord(
      (blob, ext) => {
        setRec(null);
        onBlob(blob, ext);
      },
      notify
    );
    if (h) setRec(h);
  }
  return (
    <button type="button" className={(className || 'micbtn') + (rec ? ' rec' : '')} onClick={toggle} title="Tap to talk">
      🎙️
    </button>
  );
}

// Colored terminal view: polls the session's rendered HTML and injects it,
// keeping scroll pinned to the bottom unless the user scrolled up. Resizes the
// session's PTY to the phone's width so the TUI reflows to fit — full lines are
// visible at a readable, user-adjustable font (A−/A+, persisted), no sideways scroll.
export function Terminal({ sessionId, className }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [fontPx, setFontPx] = useState(() => {
    const v = parseInt(localStorage.getItem('cvh_term_font') || '', 10);
    return v >= 8 && v <= 22 ? v : 13;
  });

  useEffect(() => {
    localStorage.setItem('cvh_term_font', String(fontPx));
  }, [fontPx]);

  // Fit the PTY to the box: measure the monospace cell at the current font, derive
  // cols/rows, and resize the session so Claude renders exactly this wide. Only
  // POST when the size actually changes; the harness skips resizes while a command
  // is running (a SIGWINCH would cancel /compact), so we retry until it applies.
  const lastFit = useRef({ cols: 0, rows: 0 });
  const fitPty = useCallback(async () => {
    const outer = outerRef.current;
    if (!outer || !outer.clientWidth) return;
    // Don't resize while the user is typing — opening the phone keyboard resizes
    // the viewport, and the resulting SIGWINCH cancels the slash-command menu (or
    // any open prompt) the user is building. The initial fit runs before focus.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${getComputedStyle(outer).fontFamily};font-size:${fontPx}px`;
    probe.textContent = 'X'.repeat(40);
    document.body.appendChild(probe);
    const charW = probe.getBoundingClientRect().width / 40;
    probe.remove();
    if (!charW) return;
    const cols = Math.max(20, Math.min(120, Math.floor((outer.clientWidth - 20) / charW)));
    const rows = Math.max(12, Math.min(60, Math.floor((outer.clientHeight - 20) / (fontPx * 1.3))));
    // Only resize on a real WIDTH (cols) change. Opening/closing the phone keyboard
    // changes height (rows) only — resizing for that fires a SIGWINCH that cancels
    // the slash-command menu or a modal right as you send. Skip height-only changes.
    if (lastFit.current.cols === cols) return;
    try {
      const r = await sessionResize(sessionId, cols, rows);
      if (r && !r.skipped) lastFit.current = { cols, rows }; // lock in only if actually applied
    } catch {
      /* offline / route not deployed yet */
    }
  }, [sessionId, fontPx]);

  useEffect(() => {
    const t = setTimeout(fitPty, 200); // one fit after open; then only on width change
    let rt;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(fitPty, 300); };
    window.addEventListener('resize', onResize); // rotation (a real width change) re-fits
    return () => { clearTimeout(t); clearTimeout(rt); window.removeEventListener('resize', onResize); };
  }, [fitPty]);

  // Push, not poll. /ws/term streams every PTY byte the instant it lands, so use it
  // as a change signal and repaint straight away instead of waiting out a timer. The
  // in-flight guard makes this self-throttling: during a burst we repaint as fast as
  // the server can render the screen and coalesce everything else into one trailing
  // repaint, so fast-scrolling output costs no more than the old interval did. The
  // slow interval stays purely as a backstop for whatever the socket misses (a
  // dropped connection, a redraw with no new bytes).
  useEffect(() => {
    let stop = false;
    let busy = false;
    let again = false;
    const paint = async () => {
      if (stop) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const { html } = await sessionScreen(sessionId);
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (outer && inner && inner.dataset.h !== (html || '')) {
          const atBottom = outer.scrollHeight - outer.scrollTop - outer.clientHeight < 60;
          const sx = outer.scrollLeft; // preserve horizontal scroll across refreshes
          inner.innerHTML = html || '';
          inner.dataset.h = html || '';
          outer.scrollLeft = sx;
          if (atBottom) outer.scrollTop = outer.scrollHeight;
        }
      } catch {
        /* transient */
      }
      busy = false;
      if (again && !stop) { again = false; paint(); }
    };

    let ws = null;
    try {
      ws = new WebSocket(termWsUrl(sessionId));
      ws.onmessage = (e) => {
        try { if (JSON.parse(e.data).t === 'data') paint(); } catch { /* ignore */ }
      };
    } catch {
      /* no socket — the backstop interval still drives the view */
    }

    paint();
    const t = setInterval(paint, 2000);
    return () => {
      stop = true;
      clearInterval(t);
      try { ws?.close(); } catch { /* already gone */ }
    };
  }, [sessionId]);

  const bump = (d) => setFontPx((f) => Math.max(8, Math.min(22, f + d)));

  return (
    <div className={'term-wrap ' + (className || '')}>
      <div className="term-fontctl">
        <button onClick={() => bump(-1)} aria-label="Smaller font">A−</button>
        <button onClick={() => bump(1)} aria-label="Larger font">A+</button>
      </div>
      <div ref={outerRef} className="screen">
        <div ref={innerRef} className="screen-inner" style={{ fontSize: fontPx + 'px' }} />
      </div>
    </div>
  );
}

// Full-screen folder browser over the PC's filesystem.
export function FolderPicker({ start, onPick, onClose, notify }) {
  const [cur, setCur] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);

  const load = async (path) => {
    try {
      const d = await fsList(path || '');
      setCur(d.path);
      setParent(d.parent);
      setDirs(d.dirs || []);
    } catch (e) {
      if (path) load('');
      else notify(e.message);
    }
  };
  useEffect(() => {
    load(start || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="picker">
      <div className="picker-head">
        <button className="ghost" onClick={() => parent && load(parent)}>⬆ Up</button>
        <div className="pkpath">{cur || 'This PC'}</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="pklist">
        {dirs.length === 0 && <div className="muted" style={{ padding: 14 }}>(no subfolders — tap “Use this folder”)</div>}
        {dirs.map((d) => (
          <button key={d.path} className="pkitem" onClick={() => load(d.path)}>
            📁&nbsp;&nbsp;{d.name}
          </button>
        ))}
      </div>
      <div className="picker-foot">{cur && <button className="primary" onClick={() => onPick(cur)}>Use this folder</button>}</div>
    </div>
  );
}
