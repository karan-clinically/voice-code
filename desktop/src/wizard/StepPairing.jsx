import React, { useEffect, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { pairingPayload, regenToken } from '../lib/api.js';

export default function StepPairing({ onBack, onDone }) {
  const [payload, setPayload] = useState(null);
  const [err, setErr] = useState('');

  const load = () => pairingPayload().then(setPayload).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  async function regen() {
    await regenToken();
    load();
  }

  return (
    <div className="stack">
      <span className="label">Step 4 · Pairing</span>
      <h2>Pair your phone</h2>
      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      {payload && (
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <div style={{ background: '#fff', padding: 12, borderRadius: 12 }}>
            <QRCodeCanvas value={JSON.stringify(payload)} size={200} />
          </div>
          <div className="stack">
            <div>
              <span className="label">Device</span>
              <div>{payload.name}</div>
            </div>
            <div>
              <span className="label">Base URL</span>
              <div><code>{payload.baseUrl}</code></div>
            </div>
            <div>
              <span className="label">Token</span>
              <div><code>{payload.token.slice(0, 12)}…</code></div>
            </div>
            <div className="row">
              <button onClick={regen}>Regenerate token</button>
            </div>
          </div>
        </div>
      )}
      <p className="muted">Scan with the phone app (Phase 2). The QR encodes the base URL and pairing token.</p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={onDone}>Finish</button>
      </div>
    </div>
  );
}
