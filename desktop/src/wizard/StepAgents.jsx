import React, { useEffect, useState } from 'react';
import { deleteCustomProvider, listProviders, saveCustomProvider, saveProviderCredential } from '../lib/api.js';

const EMPTY = {
  id: '', name: '', description: '', type: 'anthropic', endpoint: '', model: '',
  credential: '', command: '', argsText: '', resumeArgsText: '', editing: false,
};

const lines = (value) => String(value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);

export default function StepAgents({ onNext }) {
  const [providers, setProviders] = useState([]);
  const [secrets, setSecrets] = useState({});
  const [saving, setSaving] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);

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

  const field = (key) => (e) => setForm((current) => ({ ...current, [key]: e.target.value }));

  function edit(provider) {
    const config = provider.configuration || {};
    setForm({
      ...EMPTY,
      id: provider.id,
      name: provider.name,
      description: provider.description || '',
      type: config.type || 'cli',
      endpoint: config.endpoint || '',
      model: config.model || '',
      command: config.command || '',
      argsText: (config.args || []).join('\n'),
      resumeArgsText: (config.resumeArgs || []).join('\n'),
      editing: true,
    });
  }

  async function saveBrain(e) {
    e.preventDefault();
    setSaving('custom');
    setErr('');
    try {
      await saveCustomProvider({
        id: form.id,
        name: form.name,
        description: form.description,
        type: form.type,
        credential: form.credential,
        ...(form.type === 'anthropic'
          ? { endpoint: form.endpoint, model: form.model }
          : { command: form.command, args: lines(form.argsText), resumeArgs: lines(form.resumeArgsText) }),
      });
      setForm(null);
      await refresh();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(null);
    }
  }

  async function remove(provider) {
    if (!window.confirm(`Remove “${provider.name}”? Existing session history is kept.`)) return;
    setSaving(provider.id);
    setErr('');
    try {
      await deleteCustomProvider(provider.id);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="stack">
      <span className="label">Step 1 · Brains</span>
      <h2>Choose, add, and authenticate agents</h2>
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
              <div className="row">
                <span className={'badge ' + (auth.configured ? 'ok' : '')}>
                  {auth.status === 'not-required' ? 'No login needed' : auth.configured ? 'Configured' : auth.status === 'required' ? 'Key required' : 'CLI/OAuth login'}
                </span>
                {provider.configurable && <button className="mini" onClick={() => edit(provider)}>Edit</button>}
                {provider.configurable && <button className="mini" onClick={() => remove(provider)} disabled={saving === provider.id}>Remove</button>}
              </div>
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
      {!form ? (
        <button onClick={() => setForm({ ...EMPTY })}>＋ Add brain</button>
      ) : (
        <form className="card stack brain-form" onSubmit={saveBrain}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{form.editing ? 'Edit brain' : 'Add brain'}</h2>
            <button type="button" className="mini" onClick={() => setForm(null)}>Cancel</button>
          </div>
          <div className="row">
            <label className="stack brain-field">Name<input value={form.name} onChange={field('name')} placeholder="My coding brain" required /></label>
            <label className="stack brain-field">ID<input value={form.id} onChange={field('id')} placeholder="my-brain" pattern="[a-z][a-z0-9_-]+" disabled={form.editing} required /></label>
          </div>
          <label className="stack">Description<input value={form.description} onChange={field('description')} placeholder="Optional note" /></label>
          <label className="stack">Connection
            <select value={form.type} onChange={field('type')}>
              <option value="anthropic">Anthropic-compatible API endpoint</option>
              <option value="cli">Installed CLI / existing OAuth login</option>
            </select>
          </label>
          {form.type === 'anthropic' ? (
            <>
              <label className="stack">Endpoint URL<input type="url" value={form.endpoint} onChange={field('endpoint')} placeholder="https://provider.example/anthropic" required /></label>
              <label className="stack">Model ID<input value={form.model} onChange={field('model')} placeholder="provider-model-name" required /></label>
              <label className="stack">API key<input type="password" autoComplete="off" value={form.credential} onChange={field('credential')} placeholder={form.editing ? '•••• saved — blank keeps existing' : 'Required API key'} required={!form.editing} /></label>
            </>
          ) : (
            <>
              <label className="stack">Executable or command<input value={form.command} onChange={field('command')} placeholder="my-agent.cmd" required /></label>
              <label className="stack">Arguments <span className="muted">one per line; use {'{cwd}'}</span><textarea rows="3" value={form.argsText} onChange={field('argsText')} /></label>
              <label className="stack">Resume arguments <span className="muted">optional, one per line; use {'{externalSessionId}'}</span><textarea rows="3" value={form.resumeArgsText} onChange={field('resumeArgsText')} /></label>
            </>
          )}
          <button className="primary" type="submit" disabled={saving === 'custom'}>{saving === 'custom' ? 'Saving…' : 'Save brain'}</button>
        </form>
      )}
      {err && <div className="banner err">{err}</div>}
      <div className="row end"><button className="primary" onClick={onNext}>Continue</button></div>
    </div>
  );
}
