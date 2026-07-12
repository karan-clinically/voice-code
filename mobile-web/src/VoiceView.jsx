import React, { useEffect, useRef, useState } from 'react';
import { transcribe, commandText, mediaUrl, replyUrl } from './lib/api.js';
import { HandsFree } from './lib/handsfree.js';
import { basename } from './components.jsx';

// Hands-free voice session. One button starts it; after that you just talk, and
// Claude talks back. Turns auto-send — see lib/handsfree.js for why that is a
// deliberate exception to the review-before-send rule everywhere else.

const LABEL = {
  idle: 'Tap to start talking',
  listening: 'Listening…',
  thinking: 'Working…',
  speaking: 'Speaking — talk over me to interrupt',
};

export default function VoiceView({ session, onBack, notify }) {
  const [state, setState] = useState('idle');
  const [level, setLevel] = useState(0);
  const [hasReply, setHasReply] = useState(false);
  const [turns, setTurns] = useState([]); // {role, text}
  const hfRef = useRef(null);
  const logRef = useRef(null);

  const push = (role, text) => setTurns((t) => [...t.slice(-20), { role, text }]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, state]);

  // Never leave the mic open behind us.
  useEffect(() => () => hfRef.current?.stop(), []);

  async function toggle() {
    if (hfRef.current) {
      hfRef.current.stop();
      hfRef.current = null;
      setState('idle');
      setLevel(0);
      return;
    }
    const hf = new HandsFree({
      onState: setState,
      onLevel: setLevel,
      onUser: (text) => push('user', text),
      onAssistant: (text) => push('assistant', text),
      onError: (m) => notify(m),
      transcribe: (blob, ext) => transcribe(blob, ext),
      send: async (text) => {
        const d = await commandText(session.id, text);
        setHasReply(true);
        return { text: d.summary || d.responseText || '', audioUrl: d.audioUrl ? mediaUrl(d.audioUrl) : null };
      },
      fullReplyUrl: () => replyUrl(session.id, 'full'),
    });
    hfRef.current = hf;
    if (!(await hf.start())) hfRef.current = null;
  }

  const live = state !== 'idle';
  // The orb breathes with your voice while listening, and pulses while speaking.
  const scale = 1 + (state === 'thinking' ? 0 : level * 0.45);

  return (
    <div className="voice-view">
      <div className="voice-top">
        <div className="voice-title">{session.label || basename(session.cwd)}</div>
        <button className="ghost" onClick={onBack} aria-label="Close">✕</button>
      </div>

      <div className="voice-log" ref={logRef}>
        {turns.length === 0 && (
          <p className="voice-hint">
            Hands-free. Start talking and it sends itself — no Send button, no tapping between turns. Talk over Claude
            to cut it off.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={'voice-msg ' + t.role}>
            <div className="voice-bubble">{t.text}</div>
          </div>
        ))}
      </div>

      <div className="voice-stage">
        <div className={'orb ' + state} style={{ transform: `scale(${scale.toFixed(3)})` }} />
        <div className="voice-state">{LABEL[state]}</div>
      </div>

      {hasReply && (
        <button
          className="voice-full"
          onClick={() => hfRef.current?.speakFull()}
          disabled={!live || state === 'thinking'}
        >
          📖 Read that in full
        </button>
      )}

      <button className={'voice-btn' + (live ? ' on' : '')} onClick={toggle}>
        {live ? 'Stop' : 'Start'}
      </button>
    </div>
  );
}
