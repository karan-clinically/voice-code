import React, { useEffect, useRef, useState } from 'react';

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

// Terminal-style tab strip: one tab per live session. Drag a tab to reorder
// (order is the caller's concern via onReorder). Double-click renames; the
// color dot opens the native color picker. "+" opens a CLI picker so each new
// tab chooses its provider at the moment of creation.
export default function Tabs({ sessions, activeId, onSelect, onRename, onColor, onClose, onReorder }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState(null);

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
            className={'tab' + (s.id === activeId ? ' active' : '') + (s.kind === 'grok' ? ' grok' : '') + (s.kind === 'codex' ? ' codex' : '') + (s.kind === 'kimi-k3' ? ' kimi' : '') + (s.tab_color ? ' has-color' : '') + (s.id === dragId ? ' dragging' : '')}
            style={s.tab_color ? { '--tab-color': s.tab_color } : undefined}
            draggable={editing !== s.id}
            onDragStart={(e) => {
              setDragId(s.id);
              e.dataTransfer.effectAllowed = 'move';
              try { e.dataTransfer.setData('text/plain', String(s.id)); } catch { /* IE-era quirk */ }
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => {
              // Reorder live while hovering — the strip previews its final order.
              e.preventDefault();
              if (dragId != null && dragId !== s.id) onReorder?.(dragId, s.id);
            }}
            onDrop={(e) => e.preventDefault()}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => startEdit(s)}
            title={(s.kind === 'grok' ? 'Grok · ' : s.kind === 'codex' ? 'Codex · ' : s.kind === 'kimi-k3' ? 'Kimi K3 · ' : s.kind === 'shell' ? 'Shell · ' : '') + (s.cwd || '') + (status ? `\n${status.label}` : '') + '\nDouble-click to rename · drag to reorder'}
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
    </div>
  );
}

// The "+" new-tab button with its CLI picker. Rendered OUTSIDE the scrolling
// tab strip (Dashboard's header row) so it stays visible with many tabs and
// its dropdown isn't clipped by the strip's overflow.
export function NewTabButton({ providers = [], onNew }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="tab-new-wrap" ref={wrapRef}>
      <button
        className="tab-new"
        title="New tab — pick which CLI to launch"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open && (
        <div className="tab-new-menu" role="menu">
          {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider) => (
            <button
              key={provider.id}
              role="menuitem"
              className="tab-new-item"
              onClick={() => {
                setOpen(false);
                onNew(provider.id);
              }}
            >
              {provider.name}
              {provider.authentication?.status === 'required' && <span className="tab-new-note">key required</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
