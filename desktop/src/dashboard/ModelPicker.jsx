import React, { useEffect, useRef, useState } from 'react';
import { setSessionModel } from '../lib/api.js';

// Options mirror harness/src/services/models.js — kept in sync by hand since
// the alias list rarely changes and this avoids a round trip just to render it.
const OPTIONS = [
  { alias: 'default', label: 'Default' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'haiku', label: 'Haiku' },
  { alias: 'fable', label: 'Fable' },
  { alias: 'opusplan', label: 'Opus Plan' },
];

// Topbar pill showing the active session's current model (best-effort — Claude
// Code has no query API for it, so the harness infers it from settings.json at
// spawn and from the confirmation line `/model` prints on a change). Click opens
// a dropdown of the switchable aliases; picking one sends `/model <alias>` into
// the session's PTY.
export default function ModelPicker({ session, notify }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!session?.capabilities?.models) return null;

  async function pick(opt) {
    setOpen(false);
    if (opt.label === session.model) return;
    setSwitching(true);
    try {
      await setSessionModel(session.id, opt.alias);
    } catch (e) {
      notify?.('Model switch failed: ' + e.message);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="model-pick-wrap" ref={wrapRef}>
      <button
        className="model-pill"
        onClick={() => setOpen((v) => !v)}
        disabled={!session.alive}
        title="Model — click to switch"
        aria-expanded={open}
      >
        {switching ? 'Switching…' : session.model || 'Model'}
        <span className="model-caret">▾</span>
      </button>
      {open && (
        <div className="model-pick-menu" role="menu">
          {OPTIONS.map((opt) => (
            <button
              key={opt.alias}
              role="menuitem"
              className={opt.label === session.model ? 'on' : ''}
              onClick={() => pick(opt)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
