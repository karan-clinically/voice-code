import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionMode, sessionKey, attachFile, replyUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic } from './components.jsx';
import PromptsModal from './PromptsModal.jsx';

const MODES = ['ask', 'auto', 'plan', 'bypass'];
const MODE_LABEL = { ask: 'Ask', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };

// The "code container" chat input (phone): rounded card with the text field on
// top and a control row — mode pill · mic · replay · "/" prompts · attach ·
// send/stop. Pearls theme.
export default function ChatComposer({ session, onSubmit, lastAssistantText, notify }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('ask');
  const [showPrompts, setShowPrompts] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const busy = session.state === 'busy';

  const refreshMode = useCallback(() => {
    sessionMode(session.id).then((r) => r?.mode && setMode(r.mode)).catch(() => {});
  }, [session.id]);

  useEffect(() => {
    refreshMode();
    const t = setInterval(refreshMode, 4000);
    return () => clearInterval(t);
  }, [refreshMode]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [text]);

  function insert(snippet) {
    setText((prev) => (prev ? prev.replace(/\s*$/, ' ') : '') + snippet);
  }

  async function cycleMode() {
    setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]); // optimistic
    try {
      await sessionKey(session.id, 'cycle-mode');
      setTimeout(refreshMode, 400);
    } catch (e) {
      notify(e.message);
      refreshMode();
    }
  }

  // 🔊 speaks the short summary; 📖 reads the whole reply. Both go through the
  // harness by session id — it holds the text, strips the markdown, and streams,
  // so a long reply no longer blows /say's length cap the way passing the text up
  // the URL did.
  function replay(mode) {
    if (!lastAssistantText) return notify('Nothing to replay yet');
    try {
      playUrl(replyUrl(session.id, mode));
    } catch (e) {
      notify(e.message);
    }
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { path } = await attachFile(session.id, file);
      if (path) insert(/\s/.test(path) ? `"${path}" ` : `${path} `);
    } catch (err) {
      notify('Attach failed: ' + err.message);
    }
  }

  async function stop() {
    try {
      await sessionKey(session.id, 'stop');
    } catch (e) {
      notify(e.message);
    }
  }

  function send(override) {
    const t = (typeof override === 'string' ? override : text).trim();
    if (!t) return;
    setText('');
    onSubmit(t);
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        className="composer-input"
        rows={1}
        enterKeyHint="send"
        placeholder="Message this session…"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          // Phone keyboard Enter inserts a newline — treat a trailing one as Send.
          if (/\n$/.test(v)) send(v.replace(/\n+$/, ''));
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <button className={'mode-pill mode-' + mode} onClick={cycleMode}>
          <span className="mode-zap">⚡</span> {MODE_LABEL[mode]}
        </button>
        <div className="composer-spacer" />
        <DictationMic className="cbtn" text={text} setText={setText} notify={notify} />
        <button className="cbtn" onClick={() => replay('summary')} aria-label="Replay the summary">🔊</button>
        <button className="cbtn" onClick={() => replay('full')} aria-label="Read the full reply aloud">📖</button>
        <button className="cbtn" onClick={() => setShowPrompts(true)} aria-label="Saved prompts">/</button>
        <button className="cbtn" onClick={() => fileRef.current?.click()} aria-label="Attach">📎</button>
        {busy ? (
          <button className="cbtn stop" onClick={stop} aria-label="Stop">■</button>
        ) : (
          <button className="cbtn send" onClick={send} disabled={!text.trim()} aria-label="Send">➤</button>
        )}
        <input ref={fileRef} type="file" onChange={onFile} style={{ display: 'none' }} />
      </div>

      {showPrompts && (
        <PromptsModal currentText={text} onInsert={insert} onClose={() => setShowPrompts(false)} notify={notify} />
      )}
    </div>
  );
}
