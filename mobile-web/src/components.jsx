import React, { useEffect, useRef, useState } from 'react';
import { sessionScreen, fsList } from './lib/api.js';
import { tapRecord } from './lib/audio.js';

export const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

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
// keeping scroll pinned to the bottom unless the user scrolled up.
export function Terminal({ sessionId, className }) {
  const ref = useRef(null);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const { html } = await sessionScreen(sessionId);
        const el = ref.current;
        if (el && el.dataset.h !== (html || '')) {
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          const sx = el.scrollLeft;
          el.innerHTML = html || '';
          el.dataset.h = html || '';
          el.scrollLeft = sx;
          if (atBottom) el.scrollTop = el.scrollHeight;
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
  return <div ref={ref} className={'screen ' + (className || '')} />;
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
