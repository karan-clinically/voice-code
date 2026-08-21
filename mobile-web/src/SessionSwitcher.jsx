import React, { useEffect, useMemo, useRef, useState } from 'react';
import { recentSessions, listProviders } from './lib/api.js';
import { openSessionRow, canOpenRow, startSessionInFolder } from './lib/sessionOpen.js';
import { ATTENTION_TITLE, ATTENTION_SHORT, attentionOf } from './lib/attention.js';
import { readSessionCards, writeSessionCards } from './lib/localCache.js';
import { listenForResume } from './lib/resume.js';
import { cwdName, groupByFolder } from './lib/folders.js';
import { NewInFolderButton } from './components.jsx';

const ORIGIN_ICON = { phone: '📱', pc: '🖥️', terminal: '⌨️', cloud: '☁️' };

// Left slide-out list of connected sessions, opened from inside a session so you can
// jump between them without going Home. The one you're in is marked "Here"; tapping
// another switches straight to it (same open logic as the Home Sessions list).
export default function SessionSwitcher({ session, onOpen, onClose, onHome, notify }) {
  const [rows, setRows] = useState(readSessionCards);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [openingKey, setOpeningKey] = useState(null);
  const [providers, setProviders] = useState([]);
  const [starting, setStarting] = useState(false);
  const failedRefreshes = useRef(0);

  useEffect(() => {
    let stop = false;
    const load = (force = false) => recentSessions({ force })
      .then((d) => {
        if (stop) return;
        const fresh = d.sessions || [];
        setRows(fresh);
        writeSessionCards(fresh);
        failedRefreshes.current = 0;
        setUnavailable(false);
        setLoading(false);
      })
      .catch(() => {
        if (stop) return;
        failedRefreshes.current += 1;
        // A background refresh failure must not throw away the usable cached list
        // or put the drawer back into an endless initial-loading state.
        setLoading(false);
        if (failedRefreshes.current >= 2) setUnavailable(true);
      });
    load();
    const t = setInterval(load, 4000);
    const stopResume = listenForResume(() => load(true));
    return () => { stop = true; clearInterval(t); stopResume(); };
  }, []);

  useEffect(() => {
    listProviders().then((d) => setProviders(d.providers || [])).catch(() => {});
  }, []);

  const pick = (it) => {
    if (it.harnessId === session.id) { onClose(); return; } // already here
    openSessionRow(it, (s) => { onOpen(s); onClose(); }, notify, (opening) => setOpeningKey(opening ? it.key : null));
  };

  // A folder heading's ＋ starts another session in that folder and switches to it,
  // the same as tapping an existing row does.
  const startHere = async (provider, cwd) => {
    if (starting) return;
    setStarting(true);
    try {
      const fresh = await startSessionInFolder(provider, cwd);
      onOpen(fresh);
      onClose();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setStarting(false);
    }
  };

  const openable = rows.filter(canOpenRow);
  const groupedEntries = useMemo(() => groupByFolder(openable), [rows]);

  const renderSession = (it) => {
    const here = it.harnessId === session.id;
    const att = attentionOf(it);
    return (
      <button key={it.key} className={'sw-item' + (here ? ' current' : '')} onClick={() => pick(it)} disabled={!!openingKey}>
        <span className="sw-ic">{it.bgAgent ? '🤖' : ORIGIN_ICON[it.origin] || '⌨️'}</span>
        <span className="sw-body">
          <span className="sw-name">{it.name}</span>
          <span className="sw-meta">
            <span className={'sw-dot ' + (it.active ? 'busy' : 'on')} />
            {openingKey === it.key ? 'Opening…' : it.active ? 'Working' : 'Connected'} · {cwdName(it.cwd) || it.originLabel}
          </span>
        </span>
        {att && !here && (
          <span className={'sw-att cc-att-' + att} title={ATTENTION_TITLE[att]}>{ATTENTION_SHORT[att]}</span>
        )}
        {here && <span className="sw-here">Here</span>}
      </button>
    );
  };

  return (
    <>
      <div className="sw-backdrop" onClick={onClose} />
      <div className="sw-drawer">
        <div className="sw-head">
          <span>Sessions</span>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sw-list">
          {loading && (
            <div className="load-status compact" role="status">
              <span className="load-spinner" /> {rows.length ? 'Updating…' : 'Loading sessions…'}
            </div>
          )}
          {unavailable && !loading && (
            <div className="load-status compact" role="status">Session list unavailable · retrying…</div>
          )}
          {openable.length === 0 && !loading && !unavailable && (
            <div className="muted" style={{ padding: '14px 12px' }}>No other connected sessions.</div>
          )}
          {groupedEntries.map((entry) => entry.type === 'folder' ? (
            <section className="sw-folder-group" key={'folder:' + entry.key}>
              <div className="sw-folder-head" title={entry.cwd}>
                <span>📁</span>
                <span className="sw-folder-name">{cwdName(entry.cwd)}</span>
                <span className="sw-folder-count">{entry.items.length}</span>
                <NewInFolderButton
                  cwd={entry.cwd}
                  providers={providers}
                  starting={starting}
                  onStart={startHere}
                />
              </div>
              <div className="sw-folder-items">{entry.items.map(renderSession)}</div>
            </section>
          ) : renderSession(entry.item))}
        </div>
        <button className="sw-foot" onClick={onHome}>＋&nbsp;&nbsp;New session · all sessions</button>
      </div>
    </>
  );
}
