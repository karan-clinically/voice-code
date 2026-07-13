import React, { useEffect, useState } from 'react';
import { recentSessions } from './lib/api.js';
import { openSessionRow, canOpenRow } from './lib/sessionOpen.js';

const ORIGIN_ICON = { phone: '📱', pc: '🖥️', terminal: '⌨️', cloud: '☁️' };

// Left slide-out list of connected sessions, opened from inside a session so you can
// jump between them without going Home. The one you're in is marked "Here"; tapping
// another switches straight to it (same open logic as the Home Sessions list).
export default function SessionSwitcher({ session, onOpen, onClose, onHome, notify }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let stop = false;
    const load = () => recentSessions().then((d) => !stop && setRows(d.sessions || [])).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const pick = (it) => {
    if (it.harnessId === session.id) { onClose(); return; } // already here
    openSessionRow(it, (s) => { onOpen(s); onClose(); }, notify);
  };

  const openable = rows.filter(canOpenRow);

  return (
    <>
      <div className="sw-backdrop" onClick={onClose} />
      <div className="sw-drawer">
        <div className="sw-head">
          <span>Sessions</span>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sw-list">
          {openable.length === 0 && <div className="muted" style={{ padding: '14px 12px' }}>No other connected sessions.</div>}
          {openable.map((it) => {
            const here = it.harnessId === session.id;
            return (
              <button key={it.key} className={'sw-item' + (here ? ' current' : '')} onClick={() => pick(it)}>
                <span className="sw-ic">{it.bgAgent ? '🤖' : ORIGIN_ICON[it.origin] || '⌨️'}</span>
                <span className="sw-body">
                  <span className="sw-name">{it.name}</span>
                  <span className="sw-meta">
                    <span className={'sw-dot ' + (it.active ? 'busy' : 'on')} />
                    {it.active ? 'Working' : 'Connected'} · {it.originLabel}
                  </span>
                </span>
                {here && <span className="sw-here">Here</span>}
              </button>
            );
          })}
        </div>
        <button className="sw-foot" onClick={onHome}>＋&nbsp;&nbsp;New session · all sessions</button>
      </div>
    </>
  );
}
