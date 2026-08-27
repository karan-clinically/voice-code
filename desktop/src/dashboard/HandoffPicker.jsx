import React, { useEffect, useMemo, useState } from 'react';
import anthropicIcon from '../../../mobile-web/src/assets/providers/anthropic.png';
import openaiIcon from '../../../mobile-web/src/assets/providers/openai.png';
import xaiIcon from '../../../mobile-web/src/assets/providers/xai.png';
import kimiIcon from '../../../mobile-web/src/assets/providers/kimi.png';

const ICONS = { claude: anthropicIcon, codex: openaiIcon, grok: xaiIcon, 'kimi-k3': kimiIcon };

export default function HandoffPicker({ session, providers = [], onClose, onSwitch }) {
  const choices = useMemo(
    () => providers.filter((provider) => !provider.hidden && provider.id !== (session.provider_id || session.kind)),
    [providers, session.kind, session.provider_id]
  );
  const [providerId, setProviderId] = useState(choices[0]?.id || '');
  const provider = choices.find((item) => item.id === providerId) || choices[0] || null;
  const [model, setModel] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setModel(provider?.models?.[0]?.alias || '');
  }, [providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !working) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, working]);

  async function submit() {
    if (!provider || working) return;
    setWorking(true);
    setError('');
    try {
      await onSwitch(provider.id, model || null);
    } catch (err) {
      setError(err.status === 404
        ? 'Voice Harness must be restarted to enable LLM switching. Your current sessions are still running.'
        : err.message);
      setWorking(false);
    }
  }

  return (
    <div className="handoff-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !working && onClose()}>
      <div className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <div className="handoff-head">
          <div>
            <div className="handoff-kicker">Continue this work</div>
            <h2 id="handoff-title">Switch LLM</h2>
          </div>
          <button className="handoff-close" onClick={onClose} disabled={working} aria-label="Close">×</button>
        </div>
        <p className="handoff-copy">Starts a linked session in the same folder with the recent conversation and Git changes. This session stays open.</p>
        <div className="handoff-providers" role="radiogroup" aria-label="New LLM">
          {choices.map((item) => (
            <button
              key={item.id}
              className={'handoff-provider' + (item.id === provider?.id ? ' on' : '')}
              role="radio"
              aria-checked={item.id === provider?.id}
              onClick={() => setProviderId(item.id)}
              disabled={working}
              autoFocus={item.id === provider?.id}
            >
              {ICONS[item.id] ? <img src={ICONS[item.id]} alt="" /> : <span className="handoff-fallback">AI</span>}
              <span><strong>{item.name}</strong><small>{item.description}</small></span>
              {item.authentication?.status === 'required' && <em>Key required</em>}
            </button>
          ))}
          {!choices.length && <div className="handoff-empty">Configure another AI provider before switching.</div>}
        </div>
        {!!provider?.models?.length && (
          <label className="handoff-model">
            Model
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={working}>
              {provider.models.map((item) => <option key={item.alias} value={item.alias}>{item.label}</option>)}
            </select>
          </label>
        )}
        {error && <div className="handoff-error" role="alert">{error}</div>}
        <div className="handoff-actions">
          <button onClick={onClose} disabled={working}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!provider || working || provider.authentication?.status === 'required'}>
            {working ? 'Preparing handoff…' : `Switch to ${provider?.name || 'LLM'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
