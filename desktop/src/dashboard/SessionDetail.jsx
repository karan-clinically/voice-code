import React, { useEffect, useRef, useState } from 'react';
import { apiGet, sendCommand, ttsUrl } from '../lib/api.js';

const STATE_LABEL = { idle: 'idle', busy: 'working', response_ready: 'ready', dead: 'ended' };

export default function SessionDetail({ session, onBack, refreshSignal }) {
  const [history, setHistory] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const audioRef = useRef(null);
  const scrollRef = useRef(null);

  const load = () =>
    apiGet(`/api/sessions/${session.id}/history`)
      .then((d) => setHistory(d.interactions))
      .catch(() => {});

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, refreshSignal]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr('');
    setText('');
    try {
      await sendCommand(session.id, t);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function play(id) {
    if (audioRef.current) {
      audioRef.current.src = ttsUrl(id);
      audioRef.current.play();
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button onClick={onBack}>← Back</button>
        <strong>{session.label || session.cwd}</strong>
        <span className={`badge ${session.state}`}>{STATE_LABEL[session.state] || session.state}</span>
      </div>

      <div className="card" style={{ maxHeight: '52vh', overflow: 'auto' }} ref={scrollRef}>
        {history.length === 0 && <p className="muted">No interactions yet. Send a command below.</p>}
        <div className="stack">
          {history.map((i) => (
            <div key={i.id} className={`bubble ${i.direction}`}>
              <div className="bubble-meta">
                {i.direction === 'user' ? 'You' : 'Claude'} · {new Date(i.created_at + 'Z').toLocaleTimeString()}
              </div>
              <div className="bubble-text">{i.direction === 'claude' ? i.summary || i.text : i.text}</div>
              {i.hasAudio && (
                <button className="mini" onClick={() => play(i.id)}>▶ Play</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      <div className="row">
        <input
          placeholder={session.alive ? 'Type a command for Claude…' : 'Session ended'}
          disabled={!session.alive || busy}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="primary" onClick={send} disabled={!session.alive || busy || !text.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      <audio ref={audioRef} hidden />
    </div>
  );
}
