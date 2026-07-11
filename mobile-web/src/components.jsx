import React, { useEffect, useRef, useState } from 'react';
import { sessionScreen, fsList, getSttMode, setSttMode } from './lib/api.js';
import { tapRecord } from './lib/audio.js';
import { useDictation } from './lib/dictation.js';

export const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

// Dictation mic bound to a text box: the transcript lands in `text` for review
// and is NEVER sent — the caller's Send/Run button is the only way to the pty.
// In stream mode the words appear live while speaking.
export function DictationMic({ className, text, setText, notify }) {
  const { recording, toggle } = useDictation({ text, setText, notify });
  return (
    <button
      type="button"
      className={(className || 'micbtn') + (recording ? ' rec' : '')}
      onClick={toggle}
      title={recording ? 'Tap to stop' : 'Tap to talk'}
    >
      🎙️
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
// keeping scroll pinned to the bottom unless the user scrolled up. The 120-col
// TUI is auto-scaled (zoom) to fit the phone width so it reads without horizontal
// scroll; if it would get illegibly small it stops scaling and scrolls instead.
export function Terminal({ sessionId, className }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  useEffect(() => {
    let stop = false;
    const fit = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      inner.style.zoom = '1';
      const natural = inner.scrollWidth;
      const cs = getComputedStyle(outer);
      // clientWidth includes padding; the inner sits in the content box, so fit to
      // the content width (minus horizontal padding) to leave zero horizontal scroll.
      const avail = outer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      inner.style.zoom = natural > avail && avail > 0 ? String(Math.max(0.4, avail / natural)) : '1';
    };
    const poll = async () => {
      if (stop) return;
      try {
        const { html } = await sessionScreen(sessionId);
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (outer && inner && inner.dataset.h !== (html || '')) {
          const atBottom = outer.scrollHeight - outer.scrollTop - outer.clientHeight < 60;
          inner.innerHTML = html || '';
          inner.dataset.h = html || '';
          fit();
          if (atBottom) outer.scrollTop = outer.scrollHeight;
        }
      } catch {
        /* transient */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener('resize', onResize);
    };
  }, [sessionId]);
  return (
    <div ref={outerRef} className={'screen ' + (className || '')}>
      <div ref={innerRef} className="screen-inner" />
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
