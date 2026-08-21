import React, { useEffect, useRef, useState } from 'react';
import { setSessionModel } from '../lib/api.js';

// The server's provider list carries each CLI's switchable models; this copy of
// harness/src/services/models.js only covers the moment before it has loaded.
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
// the session's PTY. Same affordance as the phone's model pill.
export default function ModelPicker({ session, providers = [], notify }) {
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

  const provider = providers.find((p) => p.id === (session.provider_id || session.kind || 'claude'));
  const options = provider?.models?.length ? provider.models : OPTIONS;
  const current = session.model || '';
  // The harness reports the model as Claude prints it ("Opus 4.6 (1M)"), so an
  // option matches on its label as a prefix, not by equality.
  const isCurrent = (opt) => current === opt.label || current.startsWith(opt.label + ' ');

  async function pick(opt) {
    setOpen(false);
    if (isCurrent(opt) || switching) return;
    setSwitching(true);
    try {
      const result = await setSessionModel(session.id, opt.alias);
      notify?.(`Model changed to ${result?.model || opt.label}`);
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
        disabled={!session.alive || switching}
        title={`Current model: ${current || 'unknown'}. Click to switch.`}
        aria-expanded={open}
      >
        <span className="model-name">{switching ? 'Switching…' : current || 'Model'}</span>
        <span className="model-caret">▾</span>
      </button>
      {open && (
        <div className="model-pick-menu" role="menu">
          {options.map((opt) => (
            <button
              key={opt.alias}
              role="menuitem"
              className={isCurrent(opt) ? 'on' : ''}
              onClick={() => pick(opt)}
            >
              <span>{opt.label}</span>
              {isCurrent(opt) && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
