import React, { useEffect, useRef, useState } from 'react';
import { useSwipeable } from 'react-swipeable';
import { createSession, listProviders, transcribe, usageSummary, recentSessions, reindexArchive, killLocal, killSession, sessionInput, deleteGrokConv } from './lib/api.js';
import { openSessionRow, canOpenRow } from './lib/sessionOpen.js';
import { ATTENTION_TITLE, attentionOf } from './lib/attention.js';
import { MicButton, FolderPicker, basename } from './components.jsx';
import SpendModal, { fmtUsd } from './SpendModal.jsx';
import SettingsModal from './SettingsModal.jsx';

// Where a session was started, as a short text tag. RC = remote control (a terminal
// Claude reachable via claude.ai); "Local" (set below, off it.local) is the same kind
// of terminal Claude but NOT bridged — the harness can only offer to kill it, so it
// gets its own tag to set it apart from an RC row. Reads at a glance without decoding
// a glyph; the full label stays as the tag's title.
const ORIGIN_TAG = { phone: 'Phone', pc: 'PC', terminal: 'RC', cloud: 'Cloud', saved: 'Saved' };

// Compact relative time, like the Claude Code app ("now", "4m", "8h", "3d").
function shortAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Day bucket header (Today / Yesterday / Earlier) for a session's last activity.
const BUCKETS = ['Today', 'Yesterday', 'Earlier'];
function dayBucket(ts) {
  const t = Date.parse(ts);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startToday) return 'Today';
  if (t >= startToday - 86400000) return 'Yesterday';
  return 'Earlier';
}

// One session row, styled like the Claude Code app. Local (bare-terminal) sessions —
// a claude the harness doesn't own, running in some terminal — get iOS-style
// swipe-left-to-reveal a red Kill button, so you can clear the ones cluttering the
// list. A left swipe reveals; a right swipe or a tap on the row hides it; tapping an
// un-revealed row opens it as usual. The revealed action is Kill for anything with a
// process the harness can end, and Delete for a saved Grok conversation (a file, not a
// process). Rows the harness neither owns nor can pid-kill reveal nothing.
function SessionRow({ it, openable, onOpen, onKill, onDelete, notify }) {
  const [revealed, setRevealed] = useState(false);
  const [rcSent, setRcSent] = useState(false);
  const swiped = useRef(false);
  // Swipe-to-kill covers anything the harness can actually end: an orphan bare-terminal
  // claude (by pid) OR a harness-OWNED session (by id). Sessions the harness neither
  // owns nor can pid-kill — cloud/remote-control rows from claude.ai — stay unkillable.
  const canKill = !!((it.local && it.pid) || (it.kind === 'harness' && it.harnessId));
  // A saved Grok conversation has no process — "Kill" is meaningless. It's backed by a
  // context file, and deleting that file is the only way to clear the row, so it gets a
  // Delete action instead (worded differently: this discards the conversation itself).
  const canDelete = it.kind === 'grok-saved';
  const swipeable = canKill || canDelete;
  // Only a harness-OWNED (non-shell) session that hasn't bridged yet can have remote
  // control turned on from here: the harness owns its pty, so it can type /rc into it.
  // Orphan "Local" rows can't — the harness has no keyboard channel to them.
  const canRc = it.kind === 'harness' && (it.agentKind || 'claude') === 'claude' && !it.shell && it.remote === false;

  // Send /rc into the session's pty to start the claude.ai remote-control bridge.
  // Optimistically flip to a "connecting" hint; the 5s poll re-fetches and, once the
  // bridge is up, the row's own `remote` flag flips and the action drops away. Reset
  // after a grace window so a bridge that never connects re-shows the button.
  async function enableRc() {
    setRcSent(true);
    try {
      await sessionInput(it.harnessId, '/rc');
      setTimeout(() => setRcSent(false), 30000);
    } catch (e) {
      setRcSent(false);
      notify?.(e.message);
    }
  }

  // react-swipeable owns the swipe-vs-tap distinction: only a horizontal drag past
  // `delta` fires onSwiped*, and on touch a swipe emits no click — so taps fall
  // through to onClick untouched, keeping both gestures on the one row.
  const swipe = useSwipeable({
    onSwipedLeft: () => { if (swipeable) { swiped.current = true; setRevealed(true); } },
    onSwipedRight: () => { if (swipeable) { swiped.current = true; setRevealed(false); } },
    trackMouse: true,
    delta: 40,
  });
  const onClick = () => {
    if (swiped.current) { swiped.current = false; return; } // ignore the click a mouse-drag can emit
    if (revealed) { setRevealed(false); return; }           // tap-to-close the reveal
    if (openable) onOpen(it);
  };

  const repo = it.repo ? (it.branch ? `${it.repo} · ${it.branch}` : it.repo) : '';
  const folder = it.cwd ? basename(it.cwd) : '';
  const sub = [repo.toLowerCase().includes(folder.toLowerCase()) ? '' : folder, repo].filter(Boolean).join('  ·  ');
  const att = attentionOf(it);

  return (
    <div className="cc-row">
      {swipeable && (
        <button
          className="cc-kill"
          onClick={() => (canDelete ? onDelete(it) : onKill(it))}
          aria-label={(canDelete ? 'Delete ' : 'Kill ') + it.name}
        >
          {canDelete ? 'Delete' : 'Kill'}
        </button>
      )}
      <button
        {...(swipeable ? swipe : {})}
        className={'cc-item' + (revealed ? ' revealed' : '') + (swipeable ? ' swipeable' : '')}
        onClick={onClick}
        disabled={!openable && !swipeable}
      >
        <span className={'cc-tag cc-' + it.origin} title={it.originLabel}>
          {it.bgAgent ? 'Agent' : it.local ? 'Local' : ORIGIN_TAG[it.origin] || 'RC'}
          {att && <span className={'cc-unread cc-att-' + att} title={ATTENTION_TITLE[att] || 'Wants attention'} />}
        </span>
        <span className="cc-body">
          <span className="cc-line1">
            <span className="cc-name">{it.name}</span>
            {it.muted && <span className="cc-muted" title="Notifications silenced">🔕</span>}
            <span className="cc-time">{shortAgo(it.ts)}</span>
          </span>
          <span className="cc-status">
            <span
              className={'cc-dot ' + (it.active ? 'busy' : 'on')}
              style={it.resumeGrok ? { background: 'var(--muted, #888)' } : undefined}
            />
            <span className={'cc-conn ' + (it.active ? 'busy' : 'on')}>
              {it.resumeGrok ? 'Saved' : it.active ? 'Working' : 'Connected'}
            </span>
            {it.agentLabel && it.agentLabel !== 'Claude' && (
              <>
                <span className="cc-sep">·</span>
                <span className="cc-rc">{it.agentLabel}</span>
              </>
            )}
            {'remote' in it && (
              <>
                <span className="cc-sep">·</span>
                {canRc && !it.remote ? (
                  rcSent ? (
                    <span className="cc-rc">⏳ Turning on remote…</span>
                  ) : (
                    <span
                      className="cc-rc cc-rc-btn"
                      role="button"
                      tabIndex={0}
                      title="Send /rc to turn on claude.ai remote control"
                      onClick={(e) => { e.stopPropagation(); enableRc(); }}
                    >
                      🖥 Enable remote control
                    </span>
                  )
                ) : (
                  <span
                    className={'cc-rc' + (it.remote ? ' on' : '')}
                    title={it.remote ? 'Also on claude.ai remote control' : it.remoteReason || ''}
                  >
                    {it.remote ? '☁ Remote control' : '🖥 Local only'}
                  </span>
                )}
              </>
            )}
          </span>
          {sub && <span className="cc-sub">{sub}</span>}
          {'remote' in it && !it.remote && it.remoteReason && <span className="cc-rc-reason">{it.remoteReason}</span>}
        </span>
      </button>
    </div>
  );
}

export default function Home({ onOpen, onHistory, notify }) {
  const [showNew, setShowNew] = useState(false); // "New session" sheet
  const [path, setPath] = useState(localStorage.getItem('cvh_lastpath') || '');
  const [sessions, setSessions] = useState([]);
  const [providers, setProviders] = useState([]);
  const [picking, setPicking] = useState(false);
  const [spend, setSpend] = useState(null); // estimated total USD, for the header tally
  const [showSpend, setShowSpend] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let stop = false;
    const refresh = () => {
      recentSessions()
        .then((d) => !stop && setSessions(d.sessions || []))
        .catch(() => {});
      usageSummary()
        .then((d) => !stop && setSpend(d.totalUsd))
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    listProviders().then((d) => setProviders(d.providers || [])).catch(() => {});
  }, []);

  // Freshen the transcript archive on open so externally-run (remote-controlled)
  // sessions show up promptly — reindex is incremental, so it's cheap.
  useEffect(() => {
    reindexArchive().catch(() => {});
  }, []);

  async function startProvider(provider) {
    try {
      const p = path.trim().replace(/["']/g, '');
      const label = p ? `${basename(p)} · ${provider.name}` : provider.name;
      const s = await createSession({ providerId: provider.id, cwd: p || undefined, label });
      if (p) localStorage.setItem('cvh_lastpath', p);
      onOpen(s);
    } catch (e) {
      notify(e.message);
    }
  }
  async function startShell() {
    try {
      onOpen(await createSession({ kind: 'shell' }));
    } catch (e) {
      notify(e.message);
    }
  }
  // Tap: open a live harness session directly; a background agent opens the agent
  // view; resume any other into a harness PTY. Shared with the in-session switcher.
  const canOpen = canOpenRow;
  const openItem = (it) => openSessionRow(it, onOpen, notify);

  // Kill a session from the swipe action. An orphan bare-terminal claude goes by pid
  // (taskkill); a harness-owned session goes by id (ends its pty) — the latter also
  // drops any terminal + claude.ai bridge on it, so confirm first. Optimistically drop
  // the row, then hit the backend; on failure, re-sync from the server.
  async function killItem(it) {
    const owned = it.kind === 'harness';
    if (owned && !window.confirm(`End "${it.name}"?\n\nThis stops the session everywhere — the phone, any terminal driving it, and claude.ai remote control.`)) return;
    setSessions((prev) => prev.filter((x) => x.key !== it.key));
    try {
      await (owned ? killSession(it.harnessId) : killLocal(it.pid));
    } catch (e) {
      notify('Kill failed: ' + e.message);
      recentSessions().then((d) => setSessions(d.sessions || [])).catch(() => {});
    }
  }

  // Delete a saved Grok conversation from the swipe action. Unlike Kill this discards
  // the conversation's memory permanently — there's no History to recover it from —
  // so it always confirms. Same optimistic-drop-then-resync shape as killItem.
  async function deleteItem(it) {
    if (!window.confirm(`Delete "${it.name}"?\n\nThis permanently discards the saved Grok conversation and its memory. It cannot be resumed afterwards.`)) return;
    setSessions((prev) => prev.filter((x) => x.key !== it.key));
    try {
      await deleteGrokConv(it.resumeGrok || it.sessionId);
    } catch (e) {
      notify('Delete failed: ' + e.message);
      recentSessions().then((d) => setSessions(d.sessions || [])).catch(() => {});
    }
  }

  return (
    <div>
      <header className="topbar">
        <button className="ghost hamburger" onClick={() => setShowSettings(true)} title="Settings">☰</button>
        <h1>Voice Harness</h1>
        <div className="spacer" />
        <button className="ghost spend-btn" onClick={() => setShowSpend(true)} title="Estimated API spend">
          💲{spend != null ? ` ${fmtUsd(spend)}` : ''}
        </button>
        <button className="ghost" onClick={onHistory} title="Search & resume past sessions">🕘 History</button>
      </header>

      {showSpend && <SpendModal onClose={() => setShowSpend(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} notify={notify} />}

      {sessions.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            No connected sessions. Tap ＋ New session below, or run Claude in any terminal and it'll
            appear here. Past sessions live in 🕘 History.
          </p>
        </div>
      ) : (
        BUCKETS.map((b) => {
          const rows = sessions.filter((s) => dayBucket(s.ts) === b);
          if (rows.length === 0) return null;
          return (
            <div key={b} className="cc-group">
              <div className="cc-group-head">{b}</div>
              <div className="cc-list">
                {rows.map((it) => (
                  <SessionRow key={it.key} it={it} openable={canOpen(it)} onOpen={openItem} onKill={killItem} onDelete={deleteItem} notify={notify} />
                ))}
              </div>
            </div>
          );
        })
      )}

      <button className="cc-fab" onClick={() => setShowNew(true)}>＋ New session</button>

      {showNew && (
        <div className="pm-sheet">
          <div className="pm-sheet-head">
            <div className="sv-title">New session</div>
            <button className="ghost" onClick={() => setShowNew(false)}>✕</button>
          </div>
          <div className="pm-sheet-list">
            <div className="card stack">
              <h2>Start an agent in a folder</h2>
              <div className="row">
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\AI\voice harness" style={{ flex: 1 }} />
                <MicButton
                  className="micbtn"
                  onBlob={async (blob, ext) => {
                    try {
                      // No cleanup here — this is a folder path, not an instruction; the
                      // dictation rewrite would happily mangle it.
                      setPath(await transcribe(blob, ext, { cleanup: false }));
                    } catch (e) {
                      notify(e.message);
                    }
                  }}
                  notify={notify}
                />
              </div>
              <div className="row">
                <button style={{ flex: 1 }} onClick={() => setPicking(true)}>📁 Browse…</button>
                {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider, index) => (
                  <button
                    key={provider.id}
                    className={index === 0 ? 'primary' : ''}
                    style={{ flex: 1 }}
                    onClick={() => startProvider(provider)}
                  >
                    Start {provider.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="card stack">
              <h2>Start a shell to navigate</h2>
              <p className="muted">Opens PowerShell in your projects base. Navigate to a folder, then launch any configured AI CLI.</p>
              <button onClick={startShell}>Start shell</button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <FolderPicker
          start={path.trim().replace(/["']/g, '') || 'C:/AI'}
          onPick={(p) => {
            setPath(p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
          notify={notify}
        />
      )}
    </div>
  );
}
