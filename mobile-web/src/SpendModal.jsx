import React, { useEffect, useState } from 'react';
import { usageSummary } from './lib/api.js';

export const fmtUsd = (n) => '$' + (n > 0 && n < 0.005 ? n.toFixed(4) : n.toFixed(2));
const fmtUnits = (n, label) => {
  if (label === 'tokens') return `${Math.round(n).toLocaleString()} tokens`;
  if (label === 'audio min') return `${n.toFixed(1)} min`;
  return `${Math.round(n).toLocaleString()} ${label}`;
};

// Full-screen breakdown of estimated API spend, opened from the header $ tally.
export default function SpendModal({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    usageSummary().then(setData).catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="pm-sheet">
      <div className="pm-sheet-head">
        <div className="sv-title">API spend</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      {err && <p className="muted">{err}</p>}
      {data && (
        <>
          <div className="spend-total">
            <div className="spend-total-amt">{fmtUsd(data.totalUsd)}</div>
            <div className="spend-total-sub">
              estimated total{data.since ? ` · since ${data.since.slice(0, 10)}` : ''}
            </div>
          </div>
          <div className="pm-sheet-list">
            {data.lines.length === 0 ? (
              <p className="muted" style={{ textAlign: 'center', padding: 20 }}>No usage recorded yet.</p>
            ) : (
              data.lines.map((l, i) => (
                <div key={i} className="spend-row">
                  <div className="spend-row-main">
                    <div className="spend-row-title">{l.title}</div>
                    <div className="spend-row-sub">{fmtUnits(l.units, l.unitLabel)} · {l.calls} calls</div>
                  </div>
                  <div className="spend-row-usd">{fmtUsd(l.usd)}</div>
                </div>
              ))
            )}
          </div>
          <p className="muted spend-note">
            Estimated from list prices, calibrated to the ElevenLabs dashboard — it bills in credits, so treat the
            total as a ballpark. Speech-in seconds and OpenAI tokens are counted from when this tally shipped;
            speech-out characters include prior history.
          </p>
        </>
      )}
    </div>
  );
}
