import React, { useState } from 'react';

const tabName = (s) =>
  s.label || s.git_repo || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || `session ${s.id}`;

const TAB_STATUS = {
  busy: { kind: 'working', label: 'Working' },
  awaiting_input: { kind: 'input', label: 'Needs input' },
  response_ready: { kind: 'finished', label: 'Finished' },
  failed: { kind: 'failed', label: 'Failed' },
};

const attentionStatus = (s) => {
  if (s.attention === 'input') return TAB_STATUS.awaiting_input;
  if (s.attention === 'finished') return TAB_STATUS.response_ready;
  if (s.attention === 'failed') return TAB_STATUS.failed;
  return TAB_STATUS[s.state] || null;
};

// Terminal-style tab strip: one tab per live session. Double-click renames the
// harness tab (and Claude session); the color dot opens the native color picker.
export default function Tabs({ sessions, providers = [], activeId, onSelect, onNew, onRename, onColor, onClose }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [newProvider, setNewProvider] = useState('claude');

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
      {sessions.map((s) => {
        const status = attentionStatus(s);
        return (
          <div
            key={s.id}
            className={'tab' + (s.id === activeId ? ' active' : '') + (s.kind === 'grok' ? ' grok' : '') + (s.kind === 'codex' ? ' codex' : '') + (s.kind === 'kimi-k3' ? ' kimi' : '') + (s.tab_color ? ' has-color' : '')}
            style={s.tab_color ? { '--tab-color': s.tab_color } : undefined}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => startEdit(s)}
            title={(s.kind === 'grok' ? 'Grok · ' : s.kind === 'codex' ? 'Codex · ' : s.kind === 'kimi-k3' ? 'Kimi K3 · ' : s.kind === 'shell' ? 'Shell · ' : '') + (s.cwd || '') + (status ? `\n${status.label}` : '') + '\nDouble-click to rename'}
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
              <input
                type="color"
                className="tab-color"
                value={s.tab_color || '#3fb950'}
                title="Choose a tab color; right-click to clear"
                aria-label={`Color for ${tabName(s)}`}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => onColor(s.id, e.target.value)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onColor(s.id, null);
                }}
              />
              {s.kind === 'grok' && <span className="tab-kind" title="Grok">G</span>}
              {s.kind === 'codex' && <span className="tab-kind" title="Codex">C</span>}
              {s.kind === 'kimi-k3' && <span className="tab-kind" title="Kimi K3">K</span>}
              {tabName(s)}
            </span>
          )}
            {status && (
              <span className={'tab-status ' + status.kind} title={status.label} aria-label={status.label}>
                {status.label}
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
        );
      })}
      <div className="tab-new-wrap">
        <select
          className="tab-provider-select"
          value={newProvider}
          onChange={(e) => setNewProvider(e.target.value)}
          aria-label="Provider for new session"
          title="Provider for new session"
        >
          {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}{provider.authentication?.status === 'required' ? ' · key required' : ''}
            </option>
          ))}
        </select>
        <button
          className="tab-new"
          title="Start a new session with the selected provider"
          onClick={() => onNew(newProvider)}
        >
          + New session
        </button>
      </div>
    </div>
  );
}
