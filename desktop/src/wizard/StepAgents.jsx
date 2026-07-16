import React, { useEffect, useState } from 'react';
import { listProviders, saveProviderCredential } from '../lib/api.js';

export default function StepAgents({ onNext }) {
  const [providers, setProviders] = useState([]);
  const [secrets, setSecrets] = useState({});
  const [saving, setSaving] = useState(null);
  const [err, setErr] = useState('');

  const refresh = () => listProviders().then((d) => setProviders(d.providers || []));
  useEffect(() => { refresh().catch((e) => setErr(e.message)); }, []);

  async function save(provider) {
    const value = secrets[provider.id] || '';
    if (!value.trim()) return;
    setSaving(provider.id);
    setErr('');
    try {
      await saveProviderCredential(provider.id, value);
      setSecrets((s) => ({ ...s, [provider.id]: '' }));
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="stack">
      <span className="label">Step 1 · AI CLIs</span>
      <h2>Choose and authenticate agents</h2>
      <p className="muted">
        Each CLI owns its authentication. Existing browser/device logins remain in the CLI;
        harness-managed API keys are injected only into that provider's child process.
      </p>
      {providers.map((provider) => {
        const auth = provider.authentication || {};
        const apiKey = auth.methods?.includes('api-key');
        return (
          <div className="card stack" key={provider.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{provider.name}</strong>
              <span className={'badge ' + (auth.configured ? 'ok' : '')}>
                {auth.status === 'not-required' ? 'No login needed' : auth.configured ? 'Configured' : auth.status === 'required' ? 'Key required' : 'CLI-managed login'}
              </span>
            </div>
            {provider.description && <span className="muted">{provider.description}</span>}
            {apiKey ? (
              <div className="row">
                <input
                  type="password"
                  placeholder={auth.configured ? '•••• saved — blank keeps existing' : `${provider.name} API key`}
                  value={secrets[provider.id] || ''}
                  onChange={(e) => setSecrets((s) => ({ ...s, [provider.id]: e.target.value }))}
                />
                <button onClick={() => save(provider)} disabled={saving === provider.id || !(secrets[provider.id] || '').trim()}>
                  {saving === provider.id ? 'Saving…' : 'Save key'}
                </button>
              </div>
            ) : auth.status === 'cli-managed' ? (
              <span className="muted">Start this CLI normally and complete its own login or device-code prompt in the terminal.</span>
            ) : null}
          </div>
        );
      })}
      {err && <div className="banner err">{err}</div>}
      <div className="row end"><button className="primary" onClick={onNext}>Continue</button></div>
    </div>
  );
}
