// One cloud session: transcript, live polling while the agent runs, and the
// voice composer. When a turn completes (status_idle newer than our send), the
// final agent message is read aloud if auto-speak is on.

import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { speak, stopSpeaking } from './speech.js';
import Composer from './Composer.jsx';

const POLL_RUNNING_MS = 2500;
const POLL_IDLE_MS = 12000;

export default function SessionView({ session, onBack, autoSpeak }) {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState(session.status || 'idle');
  const [error, setError] = useState('');
  const spokenRef = useRef(new Set()); // agent.message ids already read aloud
  const primedRef = useRef(false); // true once history has loaded (don't speak old turns)
  const scrollRef = useRef(null);
  // The poll callback needs the freshest status without re-arming the effect.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let alive = true;
    let timer = null;

    async function tick() {
      try {
        const [{ events: evs }, detail] = await Promise.all([
          api.getEvents(session.id),
          api.getSession(session.id),
        ]);
        if (!alive) return;
        setError('');
        setStatus(detail.status);
        setEvents(evs);

        if (!primedRef.current) {
          evs.forEach((e) => e.type === 'agent.message' && spokenRef.current.add(e.id));
          primedRef.current = true;
        } else if (autoSpeak && detail.status === 'idle') {
          const lastMsg = [...evs].reverse().find((e) => e.type === 'agent.message' && e.text);
          if (lastMsg && !spokenRef.current.has(lastMsg.id)) {
            spokenRef.current.add(lastMsg.id);
            speak(lastMsg.text);
          }
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) {
        timer = setTimeout(tick, statusRef.current === 'running' ? POLL_RUNNING_MS : POLL_IDLE_MS);
      }
    }

    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, autoSpeak]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length]);

  async function handleSend(text) {
    stopSpeaking();
    setStatus('running');
    setEvents((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, type: 'user.message', text, local: true },
    ]);
    try {
      await api.sendMessage(session.id, text);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleInterrupt() {
    try {
      await api.interrupt(session.id);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="session-view">
      <header>
        <button className="ghost" onClick={onBack}>‹ Back</button>
        <div className="session-title">
          <strong>{session.title || session.id}</strong>
          <span className={`badge ${status}`}>{status}</span>
        </div>
        {status === 'running' && (
          <button className="ghost danger" onClick={handleInterrupt}>Stop</button>
        )}
      </header>

      {error && <div className="error-bar">{error}</div>}

      <div className="transcript" ref={scrollRef}>
        {events.length === 0 && <p className="hint">No messages yet. Say something below.</p>}
        {events.map((e) => (
          <EventRow key={e.id} event={e} onReplay={() => speak(e.text)} />
        ))}
        {status === 'running' && <div className="working-indicator">● agent working…</div>}
      </div>

      <Composer
        placeholder="Dictate or type a command…"
        onSend={handleSend}
        busy={status === 'running'}
        disabled={status === 'terminated'}
      />
    </div>
  );
}

function EventRow({ event, onReplay }) {
  switch (event.type) {
    case 'user.message':
      return <div className="msg user">{event.text}</div>;
    case 'agent.message':
      return (
        <div className="msg agent">
          <span className="msg-text">{event.text}</span>
          {event.text && (
            <button className="replay" onClick={onReplay} aria-label="Read aloud">🔊</button>
          )}
        </div>
      );
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
      return <div className="msg tool">⚙ {event.tool || 'tool'}</div>;
    case 'session.error':
      return <div className="msg error">⚠ {event.error}</div>;
    default:
      return null;
  }
}
