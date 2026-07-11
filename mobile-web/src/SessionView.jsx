import React, { useState } from 'react';
import { commandText, commandAudio, mediaUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { MicButton, Terminal, basename } from './components.jsx';

// Full-screen Claude session — terminal is the main view. The conversation mode
// (VAD) code is retained in lib/audio.js but not surfaced here; the cleanup
// toggle defaults on.
export default function SessionView({ session, onBack, notify }) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState(session.state || 'idle');
  const cleanup = true;
  const title = 'Claude · ' + (session.label || basename(session.cwd));

  async function runResult(promise) {
    setState('working…');
    try {
      const d = await promise;
      setState('ready');
      if (d.audioUrl) playUrl(mediaUrl(d.audioUrl));
    } catch (e) {
      setState('idle');
      notify(e.message);
    }
  }
  function sendText() {
    const t = text.trim();
    if (!t) return;
    setText('');
    setExpanded(false);
    runResult(commandText(session.id, t));
  }
  function sendAudio(blob, ext) {
    const fd = new FormData();
    fd.append('audio', blob, 'clip.' + ext);
    fd.append('sessionId', session.id);
    fd.append('cleanup', String(cleanup));
    runResult(commandAudio(fd));
  }

  const stateCls = 'sv-state' + (state === 'working…' ? ' busy' : state === 'ready' ? ' ready' : '');

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <div className="sv-title">{title}</div>
      </div>
      <Terminal sessionId={session.id} className="sv-term" />
      <div className="sv-bar">
        <MicButton className="micbtn" onBlob={sendAudio} notify={notify} />
        <textarea
          className={'sv-input' + (expanded ? ' expanded' : '')}
          rows={1}
          placeholder="Type a command…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setExpanded(true)}
          onBlur={() => !text.trim() && setExpanded(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
        />
        <button className="primary sv-send" onClick={sendText}>Send</button>
      </div>
      <div className={stateCls}>{state}</div>
    </div>
  );
}
