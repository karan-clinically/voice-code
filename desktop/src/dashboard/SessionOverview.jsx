import React, { useEffect } from 'react';
import { attentionStatus, tabName, NewTabButton } from './Tabs.jsx';

// Every open session at a glance, over the terminal area. The tab strip is the
// working view; this is the "where am I" view for when there are more tabs than
// fit, grouped by the folder each session runs in. Click a card to make it the
// active tab. Kind and state read as text tags — no coloured rails.
const KIND_TAG = { grok: 'Grok', codex: 'Codex', 'kimi-k3': 'Kimi K3', shell: 'Shell' };

const cwdKey = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();

// [{ cwd, items }] in tab order, so a folder takes the position of its first tab.
function groupByFolder(sessions) {
  const groups = [];
  const byKey = new Map();
  for (const s of sessions) {
    const key = cwdKey(s.cwd) || `~${s.id}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.items.push(s);
      continue;
    }
    const group = { key, cwd: s.cwd || '', items: [s] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

export default function SessionOverview({ sessions, activeId, providers, onOpen, onClose, onNew, onKill }) {
  const groups = groupByFolder(sessions);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ov">
      <header className="ov-head">
        <span className="ov-title">Sessions</span>
        <span className="ov-count">{sessions.length} open</span>
        <div className="ov-head-actions">
          <NewTabButton providers={providers} onNew={onNew} />
          <button className="tool" onClick={onClose} title="Back to the terminal">
            ✕
          </button>
        </div>
      </header>

      <div className="ov-body">
        {sessions.length === 0 ? (
          <p className="ov-empty">No sessions open. Press ＋ to launch one.</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="ov-group">
              <h2 className="ov-folder" title={g.cwd}>{g.cwd || 'No folder'}</h2>
              <div className="ov-grid">
                {g.items.map((s) => {
                  const status = attentionStatus(s);
                  const kind = KIND_TAG[s.kind];
                  return (
                    <div key={s.id} className={'ov-card' + (s.id === activeId ? ' active' : '')}>
                      <button className="ov-pick" onClick={() => onOpen(s.id)} title={`Open ${tabName(s)}`}>
                        <span className="ov-name">{tabName(s)}</span>
                        <span className="ov-meta">
                          {kind && <span className="ov-tag">{kind}</span>}
                          {status && <span className={'ov-state ' + status.kind}>{status.label}</span>}
                          {s.id === activeId && <span className="ov-tag">Current</span>}
                        </span>
                      </button>
                      <button
                        className="ov-x"
                        onClick={() => onKill(s.id)}
                        title="Close session"
                        aria-label={`Close ${tabName(s)}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
