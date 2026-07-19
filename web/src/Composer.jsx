// The command box: dictate (tap mic to start/stop) or type, review, send.

import { useRef, useState } from 'react';
import { startDictation } from './dictation.js';

export default function Composer({ placeholder, onSend, disabled, busy }) {
  const [text, setText] = useState('');
  const [recState, setRecState] = useState('idle'); // idle | recording | working
  const [status, setStatus] = useState('');
  const dictRef = useRef(null);
  const baseRef = useRef(''); // text present before dictation started

  async function toggleMic() {
    if (recState === 'recording') {
      setRecState('working');
      try {
        const finalText = await dictRef.current.stop();
        setText((prev) => joinText(baseRef.current, finalText || stripPartial(prev, baseRef.current)));
      } catch (e) {
        setStatus(e.message);
      } finally {
        dictRef.current = null;
        setRecState('idle');
        setStatus('');
      }
      return;
    }
    if (recState !== 'idle') return;
    baseRef.current = text;
    try {
      dictRef.current = await startDictation({
        onPartial: (t) => setText(joinText(baseRef.current, t)),
        onStatus: setStatus,
      });
      setRecState('recording');
    } catch (e) {
      setStatus(`mic: ${e.message}`);
      setRecState('idle');
    }
  }

  function send() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <div className="composer-row">
        <button
          type="button"
          className={`mic ${recState}`}
          onClick={toggleMic}
          disabled={recState === 'working'}
          aria-label={recState === 'recording' ? 'Stop dictation' : 'Start dictation'}
        >
          {recState === 'recording' ? '■' : recState === 'working' ? '…' : '🎤'}
        </button>
        <span className="composer-status">{status || (busy ? 'agent is working…' : '')}</span>
        <button type="button" className="send" onClick={send} disabled={disabled || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function joinText(base, added) {
  if (!base) return added;
  if (!added) return base;
  return `${base.replace(/\s+$/, '')} ${added}`;
}

// If streaming partials were painting into the box and stop() yielded nothing,
// keep whatever partial text is already there rather than blanking it.
function stripPartial(current, base) {
  return current.startsWith(base) ? current.slice(base.length).trim() : current;
}
