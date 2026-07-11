import React, { useState } from 'react';

const tabName = (s) =>
  s.label || s.git_repo || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || `session ${s.id}`;

// Terminal-style tab strip: one tab per live session, double-click to rename
// (persists + syncs to the phone), × to close, + to start a new session.
export default function Tabs({ sessions, activeId, onSelect, onNew, onRename, onClose }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');

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

  return (
    <div className="tabs">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={'tab' + (s.id === activeId ? ' active' : '')}
          onClick={() => onSelect(s.id)}
          onDoubleClick={() => startEdit(s)}
          title={s.cwd}
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
            <span className="tab-label">{tabName(s)}</span>
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
      <button className="tab-new" title="New session (pick a folder)" onClick={onNew}>
        +
      </button>
    </div>
  );
}
