import React, { useEffect, useRef, useState } from 'react';
import { sessionScreen, fsList, getSttMode, setSttMode, getSettings, saveSettings } from './lib/api.js';
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
  const [provider, setProvider] = useState('deepgram');
  const [elevenOk, setElevenOk] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setElevenOk(!!s.elevenlabs_available);
        setProvider(s.tts_provider || (s.elevenlabs_available ? 'elevenlabs' : 'deepgram'));
      })
      .catch(() => {});
  }, []);

  const choose = async (p) => {
    const prev = provider;
    setProvider(p); // optimistic
    try {
      await saveSettings({ tts_provider: p });
    } catch (e) {
      setProvider(prev);
      notify?.(e.message);
    }
  };

  return (
    <div className="seg" title="Which voice reads Claude's replies back">
      <button className={'seg-btn' + (provider === 'deepgram' ? ' on' : '')} onClick={() => choose('deepgram')}>
        Aura-2
      </button>
      <button
        className={'seg-btn' + (provider === 'elevenlabs' ? ' on' : '')}
        onClick={() => elevenOk && choose('elevenlabs')}
        disabled={!elevenOk}
      >
        ElevenLabs
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
// keeping scroll pinned to the bottom unless the user scrolled up. Renders at a
// readable, user-adjustable font (A−/A+, persisted); wide lines scroll INSIDE the
// terminal box, so the page itself never scrolls horizontally.
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
