import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fsList } from '../lib/api.js';

// Folder chooser for the served dashboard (harness /desktop in a browser), where
// there is no Electron bridge and so no native folder dialog. Browses the PC's
// directories over /api/fs/list — the same endpoint the phone's picker uses.
export default function FolderPicker({ title, start, onPick, onClose, notify }) {
  const [cur, setCur] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const inputRef = useRef(null);

  const load = useCallback(async (path, { quiet = false } = {}) => {
    setLoading(true);
    try {
      const d = await fsList(path || '');
      setCur(d.path);
      setParent(d.parent);
      setDirs(d.dirs || []);
      setDraft(d.path || '');
    } catch (e) {
      // A remembered folder that has since moved falls back to the drive list.
      if (path && !quiet) return load('', { quiet: true });
      notify?.('Cannot open folder: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load(start || '');
  }, [load, start]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fp-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="fp-head">
          <span className="fp-title">{title || 'Choose a folder'}</span>
          <button className="tool" onClick={onClose} title="Cancel (Esc)">✕</button>
        </header>

        <div className="fp-nav">
          <button className="tool" onClick={() => parent && load(parent)} disabled={!parent} title="Parent folder">
            ⬆ Up
          </button>
          <input
            ref={inputRef}
            className="fp-path"
            value={draft}
            spellCheck={false}
            placeholder="This PC — pick a drive below, or paste a path"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(draft.trim()); }}
            title="Type or paste a path, then press Enter"
          />
        </div>

        <div className="fp-list">
          {loading && dirs.length === 0 ? (
            <p className="fp-empty">Loading…</p>
          ) : dirs.length === 0 ? (
            <p className="fp-empty">No subfolders — start here, or go up.</p>
          ) : (
            dirs.map((d) => (
              <button key={d.path} className="fp-item" onClick={() => load(d.path)} title={d.path}>
                <span className="fp-item-icon">📁</span>
                {d.name}
              </button>
            ))
          )}
        </div>

        <footer className="fp-foot">
          <span className="fp-cur">{cur || 'This PC'}</span>
          <button className="tool on" disabled={!cur} onClick={() => cur && onPick(cur)}>
            Start here
          </button>
        </footer>
      </div>
    </div>
  );
}
