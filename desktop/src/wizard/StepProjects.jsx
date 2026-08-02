import React, { useEffect, useState } from 'react';
import { configState, saveConfig } from '../lib/api.js';

export default function StepProjects({ onNext, onBack }) {
  const [folder, setFolder] = useState('');
  const [autoPreview, setAutoPreview] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    configState().then((state) => {
      setFolder(state.defaultSessionDir || '');
      setAutoPreview(state.previewAutoStart !== false);
    }).catch((e) => setErr(e.message));
  }, []);

  async function choose() {
    const selected = await window.cvh?.pickFolder(folder || undefined);
    if (selected) setFolder(selected);
  }

  async function save() {
    if (!folder.trim()) {
      setErr('Choose the Desktop project folder to use for new sessions.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await saveConfig({
        default_session_dir: folder.trim(),
        preview_auto_start: autoPreview ? 'on' : 'off',
      });
      onNext();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <span className="label">Projects</span>
      <h2>Choose where new sessions open</h2>
      <p className="muted">
        The + button will immediately open this folder. You can change it here later from Settings.
        If the folder contains a web app, the harness can start and host it automatically.
      </p>
      <label className="stack">
        Default project folder
        <div className="row">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\\Users\\you\\Desktop\\my-app" />
          <button type="button" onClick={choose}>Browse…</button>
        </div>
      </label>
      <label className="row" style={{ justifyContent: 'flex-start' }}>
        <input type="checkbox" checked={autoPreview} onChange={(e) => setAutoPreview(e.target.checked)} style={{ width: 'auto' }} />
        Start and host detected web apps automatically
      </label>
      <p className="muted">
        Detection supports Vite, Next.js, npm dev/start scripts, static index.html folders, and explicit .voice-harness.json files.
      </p>
      {err && <div className="banner err">{err}</div>}
      <div className="row end">
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Continue'}</button>
      </div>
    </div>
  );
}
