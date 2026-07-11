import React, { useState } from 'react';

const SNIPPET = `{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "curl.exe",
        "args": ["-s", "-X", "POST", "http://127.0.0.1:4620/api/hooks/stop",
                 "-H", "Content-Type: application/json", "-d", "@-"],
        "timeout": 5
      }
    ]
  }
}`;

export default function StepHook({ onNext, onBack }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="stack">
      <span className="label">Step 3 · Claude Code hook</span>
      <h2>Enable instant completion detection</h2>
      <p className="muted">
        Add this <code>Stop</code> hook to your <code>~/.claude/settings.json</code> so the harness knows the exact
        moment Claude finishes and can read back the response. It uses <code>curl.exe</code> (not the PowerShell
        <code> curl</code> alias) and reads Claude's JSON from stdin. Without the hook, the harness still works via
        output-stabilization detection — just slightly slower.
      </p>
      <pre className="logbox" style={{ height: 'auto', color: '#cfcfe0' }}>{SNIPPET}</pre>
      <div className="row">
        <button onClick={copy}>{copied ? 'Copied!' : 'Copy snippet'}</button>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}
