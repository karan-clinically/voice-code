import React, { useEffect, useMemo, useState } from 'react';
import anthropicIcon from './assets/providers/anthropic.png';
import openaiIcon from './assets/providers/openai.png';
import xaiIcon from './assets/providers/xai.png';
import kimiIcon from './assets/providers/kimi.png';

const ICONS = { claude: anthropicIcon, codex: openaiIcon, grok: xaiIcon, 'kimi-k3': kimiIcon };

export default function HandoffSheet({ session, providers = [], onClose, onSwitch }) {
  const choices = useMemo(
    () => providers.filter((provider) => !provider.hidden && provider.id !== (session.provider_id || session.kind)),
    [providers, session.kind, session.provider_id]
  );
  const [providerId, setProviderId] = useState(choices[0]?.id || '');
  const provider = choices.find((item) => item.id === providerId) || choices[0] || null;
  const [model, setModel] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setModel(provider?.models?.[0]?.alias || ''), [providerId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="sv-model-backdrop handoff-mobile-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && !working && onClose()}>
      <div className="sv-model-sheet handoff-mobile-sheet" role="dialog" aria-modal="true" aria-labelledby="handoff-mobile-title" onClick={(event) => event.stopPropagation()}>
        <div className="sv-model-sheet-head">
          <div>
            <div className="sv-menu-head">Continue this work</div>
            <strong id="handoff-mobile-title">Switch LLM</strong>
          </div>
          <button className="ghost sv-model-close" onClick={onClose} disabled={working} aria-label="Close">×</button>
        </div>
        <p className="handoff-mobile-copy">A linked session opens in this folder with the recent conversation and Git changes. This session stays open.</p>
        <div className="handoff-mobile-providers" role="radiogroup" aria-label="New LLM">
          {choices.map((item) => (
            <button
              key={item.id}
              className={'handoff-mobile-provider' + (item.id === provider?.id ? ' on' : '')}
              role="radio"
              aria-checked={item.id === provider?.id}
              onClick={() => setProviderId(item.id)}
              disabled={working}
            >
              {ICONS[item.id] ? <img src={ICONS[item.id]} alt="" /> : <span className="handoff-mobile-fallback">AI</span>}
              <span><strong>{item.name}</strong><small>{item.description}</small></span>
              {item.authentication?.status === 'required' && <em>Key required</em>}
            </button>
          ))}
          {!choices.length && <div className="sv-model-empty">Configure another AI provider before switching.</div>}
        </div>
        {!!provider?.models?.length && (
          <label className="handoff-mobile-model">
            Model
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={working}>
              {provider.models.map((item) => <option key={item.alias} value={item.alias}>{item.label}</option>)}
            </select>
          </label>
        )}
        {error && <div className="handoff-mobile-error" role="alert">{error}</div>}
        <button
          className="primary handoff-mobile-submit"
          onClick={submit}
          disabled={!provider || working || provider.authentication?.status === 'required'}
        >
          {working ? 'Preparing handoff…' : `Switch to ${provider?.name || 'LLM'}`}
        </button>
      </div>
    </div>
  );
}
