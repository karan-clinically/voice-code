import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { folderKey } from '../lib/folders.js';

export const tabName = (s) =>
  s.label || s.git_repo || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || `session ${s.id}`;

const TAB_STATUS = {
  busy: { kind: 'working', label: 'Working' },
  awaiting_input: { kind: 'input', label: 'Needs input' },
  response_ready: { kind: 'finished', label: 'Finished' },
  failed: { kind: 'failed', label: 'Failed' },
};

// Shared with the sessions overview so a session reads the same in both places.
export const attentionStatus = (s) => {
  if (s.attention === 'input') return TAB_STATUS.awaiting_input;
  if (s.attention === 'finished') return TAB_STATUS.response_ready;
  if (s.attention === 'failed') return TAB_STATUS.failed;
  return TAB_STATUS[s.state] || null;
};

// The provider list both "+" buttons show. One definition so the header's new-tab
// picker and a tab's own "another session here" picker can never drift apart.
function CliChoices({ providers = [], onPick }) {
  return (providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider) => (
    <button key={provider.id} role="menuitem" className="tab-new-item" onClick={() => onPick(provider.id)}>
      {provider.name}
      {provider.authentication?.status === 'required' && <span className="tab-new-note">key required</span>}
    </button>
  ));
}

// Terminal-style tab strip: one tab per live session. Drag a tab to reorder
// (order is the caller's concern via onReorder). Double-click renames; the
// color dot opens the native color picker. "+" opens a CLI picker so each new
// tab chooses its provider at the moment of creation.
export default function Tabs({ sessions, activeId, onSelect, onRename, onColor, onClose, onReorder, providers = [], onNewInFolder, tabColors = new Map(), folderStarts = new Set() }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState(null);
  // Which tab's "+" is open, and where to hang its menu. The strip scrolls and
  // clips (overflow-y: hidden), so this one is positioned against the viewport
  // and rendered into <body> rather than inside the tab.
  const [addFor, setAddFor] = useState(null);
  const addMenuRef = useRef(null);

  useEffect(() => {
    if (!addFor) return undefined;
    const onDoc = (e) => {
      if (addMenuRef.current?.contains(e.target)) return;
      // A click on any "+" is that button's business: closing here first would
      // make clicking the open tab's own "+" re-open it instead of toggling shut.
      if (e.target.closest?.('.tab-add')) return;
      setAddFor(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setAddFor(null);
    };
    // Scrolling the strip or resizing moves the button out from under the menu.
    // Only the strip's own scroll counts — a document-wide listener would close
    // the menu the moment live terminal output scrolled behind it.
    const drop = () => setAddFor(null);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', drop);
    addFor.strip?.addEventListener('scroll', drop);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', drop);
      addFor.strip?.removeEventListener('scroll', drop);
    };
  }, [addFor]);

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
      {sessions.map((s, i) => {
        const status = attentionStatus(s);
        // A folder's colour, not this tab's: sessions on one project should look
        // like one project even when they were coloured one at a time. Its own
        // colour is the fallback for a session with no folder at all.
        const color = tabColors.get(folderKey(s.cwd)) || s.tab_color || null;
        const groupStart = i > 0 && folderStarts.has(s.id);
        return (
          <div
            key={s.id}
            className={'tab' + (s.id === activeId ? ' active' : '') + (s.kind === 'grok' ? ' grok' : '') + (s.kind === 'codex' ? ' codex' : '') + (s.kind === 'kimi-k3' ? ' kimi' : '') + (color ? ' has-color' : '') + (groupStart ? ' folder-start' : '') + (s.id === dragId ? ' dragging' : '')}
            style={color ? { '--tab-color': color } : undefined}
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
                value={color || '#3fb950'}
                title="Choose the colour for this folder's tabs; right-click to clear"
                aria-label={`Colour for the ${folderName(s)} folder`}
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
            {s.cwd && onNewInFolder && (
              <button
                className="tab-add"
                title={`New session in ${folderName(s)} — pick which CLI to launch`}
                aria-label={`New session in ${folderName(s)}`}
                aria-expanded={addFor?.id === s.id}
                onClick={(e) => {
                  e.stopPropagation(); // the tab itself would switch sessions
                  const rect = e.currentTarget.getBoundingClientRect();
                  const strip = e.currentTarget.closest('.tabs-scroll');
                  setAddFor((prev) => (prev?.id === s.id ? null : { id: s.id, session: s, rect, strip }));
                }}
              >
                +
              </button>
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
      {addFor && createPortal(
        <div
          className="tab-new-menu floating"
          role="menu"
          ref={addMenuRef}
          style={{ top: addFor.rect.bottom + 6, left: addFor.rect.left }}
        >
          <div className="tab-new-head">New session in {folderName(addFor.session)}</div>
          <CliChoices
            providers={providers}
            onPick={(providerId) => {
              setAddFor(null);
              onNewInFolder(addFor.session, providerId);
            }}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

// What to call the folder a tab is working in. The label can be renamed to
// anything, so the "+" names the directory it will actually launch in.
export const folderName = (s) => (s?.cwd || '').split(/[\\/]/).filter(Boolean).pop() || s?.cwd || 'this folder';

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
          <CliChoices
            providers={providers}
            onPick={(providerId) => {
              setOpen(false);
              onNew(providerId);
            }}
          />
        </div>
      )}
    </div>
  );
}
