import React, { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe, commandText, mediaUrl, replyUrl, selectPromptOption, sessionMessages } from './lib/api.js';
import { HandsFree } from './lib/handsfree.js';
import { useWakeLock, keepAwakeEnabled } from './lib/wakeLock.js';
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
  const [turns, setTurns] = useState([]); // persisted conversation + optimistic user echoes
  const [prompt, setPrompt] = useState(null); // interactive picker Claude is waiting on
  const hfRef = useRef(null);
  const logRef = useRef(null);
  const lastId = useRef(0);
  const localSeq = useRef(0);

  // Voice mode shows the SAME persisted conversation the Chat view does, so history
  // survives navigating away and coming back (user turns are recorded by /command,
  // assistant turns by the Stop hook — both into the `messages` table). An optimistic
  // user echo appears instantly and is dropped once the server returns the same text;
  // the assistant bubble arrives on the next poll with its full text.
  const pushUser = (text) =>
    setTurns((t) => [...t, { id: `local-${++localSeq.current}`, role: 'user', text }].slice(-40));
  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last } = await sessionMessages(session.id, lastId.current);
      if (fresh.length) {
        lastId.current = last;
        setTurns((prev) => {
          let base = prev;
          for (const f of fresh) {
            if (f.role === 'user') base = base.filter((m) => !(String(m.id).startsWith('local-') && m.text === f.text));
          }
          return [...base, ...fresh].slice(-40);
        });
      }
    } catch {
      /* transient */
    }
  }, [session.id]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1600);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, state]);

  // Never leave the mic open behind us.
  useEffect(() => () => hfRef.current?.stop(), []);

  // Keep the screen awake while hands-free is running, so the spoken reply plays
  // out instead of the phone sleeping between "you asked" and "Claude answers".
  // Gated on the per-device Settings toggle (default on).
  useWakeLock(state !== 'idle' && keepAwakeEnabled());

  async function toggle() {
    if (hfRef.current) {
      hfRef.current.stop();
      hfRef.current = null;
      setState('idle');
      setLevel(0);
      setPrompt(null);
      return;
    }
    // Map a /command or /select response into the reply shape HandsFree expects.
    const toReply = (d) => {
      setHasReply(true);
      return {
        text: d.summary || d.responseText || '',
        audioUrl: d.audioUrl ? mediaUrl(d.audioUrl) : null,
        prompt: d.prompt || null,
      };
    };
    const hf = new HandsFree({
      onState: setState,
      onLevel: setLevel,
      onUser: (text) => pushUser(text),
      onAssistant: () => {}, // the persisted assistant reply arrives via the /messages poll
      onError: (m) => notify(m),
      onPrompt: setPrompt,
      transcribe: (blob, ext) => transcribe(blob, ext),
      // Conversational cap: if a turn never signals completion, fail in ~2 min so
      // the loop recovers, rather than hanging on the 10-minute default.
      send: async (text) => toReply(await commandText(session.id, text, 120_000)),
      select: async (index) => toReply(await selectPromptOption(session.id, index)),
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
        {turns.map((t) => (
          <div key={t.id} className={'voice-msg ' + t.role}>
            <div className="voice-bubble">{t.text}</div>
          </div>
        ))}
      </div>

      <div className="voice-stage">
        <div className={'orb ' + state} style={{ transform: `scale(${scale.toFixed(3)})` }} />
        <div className="voice-state">{LABEL[state]}</div>
      </div>

      {prompt && (
        <div className="voice-prompt">
          {prompt.multi ? (
            <p className="voice-hint">Claude is asking a multi-part question — open the Terminal view to answer it.</p>
          ) : (
            <>
              <div className="voice-prompt-hint">Tap an option, or say its number</div>
              <div className="voice-prompt-opts">
                {prompt.options.map((o) => (
                  <button key={o.n} className="voice-opt" onClick={() => hfRef.current?.chooseOption(o.n)} disabled={!live}>
                    <span className="voice-opt-n">{o.n}</span>
                    <span className="voice-opt-label">{o.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

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
