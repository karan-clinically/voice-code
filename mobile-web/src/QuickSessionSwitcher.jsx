import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ATTENTION_SHORT, attentionOf } from './lib/attention.js';
import { canOpenRow, openSessionRow } from './lib/sessionOpen.js';

const ORIGIN_ICON = { phone: '📱', pc: '🖥️', terminal: '⌨️', cloud: '☁️' };
const DISMISS_MS = 5000;
const SCROLL_SETTLE_MS = 700;

// A short-lived, phone-friendly equivalent of Alt-Tab. It intentionally only
// includes live harness tabs: choosing an archived row here must never silently
// resume or fork a conversation.
export default function QuickSessionSwitcher({ session, rows, onOpen, onClose, notify }) {
  const [openingKey, setOpeningKey] = useState(null);
  const [timerPaused, setTimerPaused] = useState(false);
  const dismissTimer = useRef(null);
  const scrollSettleTimer = useRef(null);
  const remainingMs = useRef(DISMISS_MS);
  const timerStartedAt = useRef(0);
  const tabs = useMemo(
    () => rows.filter((it) => canOpenRow(it) && it.kind === 'harness' && it.alive && it.harnessId),
    [rows]
  );

  const resumeTimer = () => {
    if (dismissTimer.current || remainingMs.current <= 0) return;
    setTimerPaused(false);
    timerStartedAt.current = performance.now();
    dismissTimer.current = setTimeout(onClose, remainingMs.current);
  };

  const pauseTimer = () => {
    if (dismissTimer.current) {
      remainingMs.current = Math.max(0, remainingMs.current - (performance.now() - timerStartedAt.current));
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    setTimerPaused(true);
  };

  const scrolling = () => {
    pauseTimer();
    clearTimeout(scrollSettleTimer.current);
    scrollSettleTimer.current = setTimeout(resumeTimer, SCROLL_SETTLE_MS);
  };

  useEffect(() => {
    resumeTimer();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(dismissTimer.current);
      clearTimeout(scrollSettleTimer.current);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const pick = (it) => {
    if (it.harnessId === session.id) {
      onClose();
      return;
    }
    openSessionRow(
      it,
      (next) => {
        onOpen(next, { replaceHistory: true });
        onClose();
      },
      notify,
      (opening) => setOpeningKey(opening ? it.key : null)
    );
  };

  return (
    <div className="qsw-backdrop" onClick={onClose}>
      <div
        className="qsw-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Switch open session"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qsw-head">Open tabs</div>
        <div
          className="qsw-row"
          onPointerDown={pauseTimer}
          onPointerUp={resumeTimer}
          onPointerCancel={resumeTimer}
          onScroll={scrolling}
        >
          {tabs.map((it) => {
            const current = it.harnessId === session.id;
            const attention = attentionOf(it);
            return (
              <button
                key={it.key}
                className={'qsw-tab' + (current ? ' current' : '')}
                onClick={() => pick(it)}
                disabled={!!openingKey}
                aria-current={current ? 'page' : undefined}
              >
                <span className="qsw-icon">{it.bgAgent ? '🤖' : ORIGIN_ICON[it.origin] || '⌨️'}</span>
                <span className="qsw-name">{it.name}</span>
                <span className="qsw-meta">
                  <span className={'qsw-dot' + (it.active ? ' busy' : '')} />
                  {openingKey === it.key ? 'Opening…' : current ? 'Current' : attention ? ATTENTION_SHORT[attention] : it.active ? 'Working' : 'Connected'}
                </span>
              </button>
            );
          })}
          {tabs.length === 0 && <span className="qsw-empty">No open tabs</span>}
        </div>
        <div className={'qsw-timeout' + (timerPaused ? ' paused' : '')} aria-hidden="true" />
      </div>
    </div>
  );
}
