import React from 'react';

const STATE_LABEL = { idle: 'idle', busy: 'working', response_ready: 'ready', dead: 'ended' };

export default function SessionCard({ session, onOpen }) {
  const cwdBase = (session.cwd || '').split(/[\\/]/).filter(Boolean).pop();
  return (
    <button className="session-card" onClick={onOpen}>
      <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
        <strong>{session.label || cwdBase || session.tmux_session}</strong>
        <span className={`badge ${session.state}`}>{STATE_LABEL[session.state] || session.state}</span>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{cwdBase}</div>
      {session.git_repo && (
        <div className="muted" style={{ fontSize: 12 }}>
          {session.git_repo} · {session.git_branch || '—'}
        </div>
      )}
    </button>
  );
}
