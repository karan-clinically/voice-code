import React, { useEffect, useState } from 'react';
import { deleteCustomProvider, listProviders, saveCustomProvider, saveProviderCredential } from './lib/api.js';

const EMPTY = {
  id: '', name: '', description: '', type: 'anthropic', endpoint: '', model: '',
  credential: '', command: '', argsText: '', resumeArgsText: '', editing: false,
};
const lines = (value) => String(value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);

export default function BrainSettings({ notify, onChanged }) {
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(null);
  const [credential, setCredential] = useState({});
  const [busy, setBusy] = useState(null);

  const refresh = () => listProviders().then((data) => setProviders(data.providers || []));
  useEffect(() => { refresh().catch((e) => notify?.(e.message)); }, []);

  const field = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const edit = (provider) => {
    const config = provider.configuration || {};
    setForm({
      ...EMPTY, editing: true, id: provider.id, name: provider.name,
      description: provider.description || '', type: config.type || 'cli',
      endpoint: config.endpoint || '', model: config.model || '', command: config.command || '',
      argsText: (config.args || []).join('\n'), resumeArgsText: (config.resumeArgs || []).join('\n'),
    });
  };

  async function changed() {
    await refresh();
    onChanged?.();
  }

  async function saveBrain(event) {
    event.preventDefault();
    setBusy('form');
    try {
      await saveCustomProvider({
        id: form.id, name: form.name, description: form.description, type: form.type,
        credential: form.credential,
        ...(form.type === 'anthropic'
          ? { endpoint: form.endpoint, model: form.model }
          : { command: form.command, args: lines(form.argsText), resumeArgs: lines(form.resumeArgsText) }),
      });
      setForm(null);
      await changed();
      notify?.('Brain saved.');
    } catch (e) {
      notify?.(e.message);
    }
    setBusy(null);
  }

  async function saveKey(provider) {
    const value = credential[provider.id] || '';
    if (!value.trim()) return;
    setBusy(provider.id);
    try {
      await saveProviderCredential(provider.id, value);
      setCredential((current) => ({ ...current, [provider.id]: '' }));
      await changed();
      notify?.(`${provider.name} key saved.`);
    } catch (e) {
      notify?.(e.message);
    }
    setBusy(null);
  }

  async function remove(provider) {
    if (!window.confirm(`Remove “${provider.name}”? Existing session history is kept.`)) return;
    setBusy(provider.id);
    try {
      await deleteCustomProvider(provider.id);
      await changed();
      notify?.('Brain removed.');
    } catch (e) {
      notify?.(e.message);
    }
    setBusy(null);
  }

  return (
    <div className="stack brain-settings">
      {providers.map((provider) => {
        const auth = provider.authentication || {};
        return (
          <div className="brain-row" key={provider.id}>
            <div className="brain-row-head">
              <span><strong>{provider.name}</strong><span className="muted"> · {auth.configured ? 'configured' : auth.status === 'required' ? 'key required' : 'CLI/OAuth login'}</span></span>
              {provider.configurable && <button className="ghost" onClick={() => edit(provider)}>Edit</button>}
              {provider.configurable && <button className="ghost" onClick={() => remove(provider)} disabled={busy === provider.id}>Remove</button>}
            </div>
            {provider.description && <div className="muted">{provider.description}</div>}
            {provider.configuration?.type === 'anthropic' && (
              <div className="muted"><code>{provider.configuration.endpoint}</code> · model <code>{provider.configuration.model}</code></div>
            )}
            {auth.methods?.includes('api-key') && (
              <div className="row">
                <input type="password" autoComplete="off" value={credential[provider.id] || ''} onChange={(e) => setCredential((current) => ({ ...current, [provider.id]: e.target.value }))} placeholder={auth.configured ? '•••• saved — enter to replace' : provider.id === 'grok' ? 'xAI key from console.x.ai: xai-…' : 'API key for this endpoint'} />
                <button onClick={() => saveKey(provider)} disabled={busy === provider.id || !(credential[provider.id] || '').trim()}>Save</button>
              </div>
            )}
          </div>
        );
      })}

      {!form ? <button onClick={() => setForm({ ...EMPTY })}>＋ Add brain</button> : (
        <form className="stack brain-editor" onSubmit={saveBrain}>
          <div className="brain-row-head"><strong>{form.editing ? 'Edit brain' : 'Add brain'}</strong><button type="button" className="ghost" onClick={() => setForm(null)}>Cancel</button></div>
          <label className="stack">Name<input value={form.name} onChange={field('name')} placeholder="My coding brain" required /></label>
          <label className="stack">ID<input value={form.id} onChange={field('id')} placeholder="my-brain" pattern="[a-z][a-z0-9_-]+" disabled={form.editing} required /></label>
          <label className="stack">Connection<select value={form.type} onChange={field('type')}><option value="anthropic">Anthropic-compatible API</option><option value="cli">Installed CLI / OAuth login</option></select></label>
          {form.type === 'anthropic' ? <>
            <label className="stack">Endpoint URL<input type="url" value={form.endpoint} onChange={field('endpoint')} placeholder="https://provider.example/anthropic" required /></label>
            <label className="stack">Model ID<input value={form.model} onChange={field('model')} required /></label>
            <label className="stack">API key<input type="password" autoComplete="off" value={form.credential} onChange={field('credential')} placeholder={form.editing ? '•••• blank keeps existing' : 'Required'} required={!form.editing} /></label>
          </> : <>
            <label className="stack">Executable<input value={form.command} onChange={field('command')} placeholder="my-agent" required /></label>
            <label className="stack">Arguments, one per line<textarea rows="3" value={form.argsText} onChange={field('argsText')} placeholder="--project&#10;{cwd}" /></label>
            <label className="stack">Resume arguments, one per line<textarea rows="3" value={form.resumeArgsText} onChange={field('resumeArgsText')} placeholder="--resume&#10;{externalSessionId}" /></label>
          </>}
          <button className="primary" type="submit" disabled={busy === 'form'}>{busy === 'form' ? 'Saving…' : 'Save brain'}</button>
        </form>
      )}
    </div>
  );
}
