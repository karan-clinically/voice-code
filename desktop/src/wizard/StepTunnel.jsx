import React, { useState } from 'react';
import { saveConfig, tailscaleDetect } from '../lib/api.js';

export default function StepTunnel({ onNext, onBack }) {
  const [provider, setProvider] = useState('tailscale');
  const [ts, setTs] = useState(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function detect() {
    setBusy(true);
    setErr('');
    try {
      const r = await tailscaleDetect();
      setTs(r);
      if (!r.installed) setErr('Tailscale not detected. Install it, or pick another option.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cont() {
    setErr('');
    let url = '';
    if (provider === 'tailscale') {
      if (!ts?.baseUrl) {
        setErr('Run "Detect Tailscale" first.');
        return;
      }
      url = ts.baseUrl;
    } else if (provider === 'custom') {
      url = custom.trim();
      if (!/^https?:\/\//.test(url)) {
        setErr('Enter a full URL (http://host:port).');
        return;
      }
    }
    try {
      await saveConfig({ tunnel_provider: provider, tunnel_url: url });
      onNext();
    } catch (e) {
      setErr(e.message);
    }
  }

  const Radio = ({ value, children }) => (
    <label className="row">
      <input type="radio" style={{ width: 'auto' }} checked={provider === value} onChange={() => setProvider(value)} />
      {children}
    </label>
  );

  return (
    <div className="stack">
      <span className="label">Step 2 · Tunnel</span>
      <h2>How your phone reaches this PC</h2>

      <Radio value="tailscale">Tailscale <span className="muted">(recommended)</span></Radio>
      {provider === 'tailscale' && (
        <div className="stack" style={{ paddingLeft: 24 }}>
          <div className="row">
            <button onClick={detect} disabled={busy}>{busy ? 'Detecting…' : 'Detect Tailscale'}</button>
          </div>
          {ts && ts.installed && (
            <p className="muted">
              Online: {String(ts.online)} · {ts.hostname || ts.ip}
              <br />
              Base URL: <code>{ts.baseUrl}</code>
            </p>
          )}
        </div>
      )}

      <Radio value="lan">Local network only</Radio>
      <Radio value="custom">Custom URL</Radio>
      {provider === 'custom' && (
        <input placeholder="http://my-host:4620" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ marginLeft: 24, width: 'calc(100% - 24px)' }} />
      )}

      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={cont}>Continue</button>
      </div>
    </div>
  );
}
