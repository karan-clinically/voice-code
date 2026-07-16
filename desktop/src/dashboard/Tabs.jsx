import React, { useEffect, useRef, useState } from 'react';

const tabName = (s) =>
  s.label || s.git_repo || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || `session ${s.id}`;

// Terminal-style tab strip: one tab per live session, double-click to rename
// (persists + syncs to the phone), × to close, + menu to start Claude, Grok, or Codex.
export default function Tabs({ sessions, providers = [], activeId, onSelect, onNew, onRename, onClose }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  function startEdit(s) {
    setEditing(s.id);
    setDraft(tabName(s));
  }
  function commit() {
    if (editing != null) {
      const v = draft.trim();
      if (v) onRename(editing, v);
    }
    setEditing(null);
  }

  function pick(kind) {
    setMenuOpen(false);
    onNew(kind);
  }

  return (
    <div className="tabs">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={'tab' + (s.id === activeId ? ' active' : '') + (s.kind === 'grok' ? ' grok' : '') + (s.kind === 'codex' ? ' codex' : '')}
          onClick={() => onSelect(s.id)}
          onDoubleClick={() => startEdit(s)}
          title={(s.kind === 'grok' ? 'Grok · ' : s.kind === 'codex' ? 'Codex · ' : s.kind === 'shell' ? 'Shell · ' : '') + (s.cwd || '')}
        >
          {editing === s.id ? (
            <input
              autoFocus
              className="tab-edit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <span className="tab-label">
              {s.kind === 'grok' && <span className="tab-kind" title="Grok">G</span>}
              {s.kind === 'codex' && <span className="tab-kind" title="Codex">C</span>}
              {tabName(s)}
            </span>
          )}
          <button
            className="tab-x"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation();
              onClose(s.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div className="tab-new-wrap" ref={menuRef}>
        <button
          className="tab-new"
          title="New AI CLI session"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
        >
          +
        </button>
        {menuOpen && (
          <div className="tab-new-menu" role="menu">
            {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider) => (
              <button key={provider.id} role="menuitem" onClick={() => pick(provider.id)}>
                {provider.name}
                {provider.authentication?.status === 'required' ? ' · key required' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
