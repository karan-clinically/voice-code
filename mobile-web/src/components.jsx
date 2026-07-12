import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionScreen, sessionResize, fsList, getSttMode, setSttMode, getSettings, saveSettings } from './lib/api.js';
import { tapRecord } from './lib/audio.js';
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

// Which voice reads replies back. Mirrors the desktop setting (same config key);
// the ElevenLabs option is offered only when a key for it exists on the PC — the
// phone learns that as a boolean and never sees the key itself.
export function TtsProviderToggle({ notify }) {
  const [stt, setStt] = useState('deepgram');
  const [tts, setTts] = useState('deepgram');
  const [elevenOk, setElevenOk] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setElevenOk(!!s.elevenlabs_available);
        const fallback = s.elevenlabs_available ? 'elevenlabs' : 'deepgram';
        setStt(s.stt_provider || 'deepgram');
        setTts(s.tts_provider || fallback);
      })
      .catch(() => {});
  }, []);

  // Both halves run on the chosen vendor — one key, one credit pool. (The desktop
  // wizard can still mix them; this shows "Mixed" if it has been.)
  const vendor = stt === tts ? stt : 'mixed';
  const choose = async (v) => {
    const prev = { stt, tts };
    setStt(v);
    setTts(v); // optimistic
    try {
      await saveSettings({ stt_provider: v, tts_provider: v });
    } catch (e) {
      setStt(prev.stt);
      setTts(prev.tts);
      notify?.(e.message);
    }
  };

  return (
    <div className="seg" title="Which vendor does both the listening and the speaking">
      <button className={'seg-btn' + (vendor === 'deepgram' ? ' on' : '')} onClick={() => choose('deepgram')}>
        Deepgram
      </button>
      <button
        className={'seg-btn' + (vendor === 'elevenlabs' ? ' on' : '')}
        onClick={() => elevenOk && choose('elevenlabs')}
        disabled={!elevenOk}
      >
        ElevenLabs
      </button>
      {vendor === 'mixed' && <button className="seg-btn on" disabled>Mixed</button>}
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

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop) return;
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
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
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
