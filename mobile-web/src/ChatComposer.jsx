import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionMode, sessionKey, attachFile, replyUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic } from './components.jsx';
import PromptsModal from './PromptsModal.jsx';
import SlashCommands from './SlashCommands.jsx';

const MODES = ['ask', 'auto', 'plan', 'bypass'];
const MODE_LABEL = { ask: 'Ask', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };

// The "code container" input (phone): rounded card with the text field on top and
// a control row — mic · "/" · attach · ⋯ · send/stop. The less-used controls
// (permission mode pill + 🔊/📖 read-aloud) live behind the ⋯ overflow so the bar
// fits a narrow phone. Shared by Chat and Terminal so both views are identical.
// Terminal adds one extra button (⌨ keypad, via onKeypad) that Chat doesn't have.
export default function ChatComposer({
  session,
  onSubmit,
  lastAssistantText = '',
  notify,
  placeholder = 'Message this session…',
  busy,
  allowEmptySend = false,
  promptPending = false, // terminal-only: a question/permission dialog is on screen
  plainText = false, // true = no autocapitalize/autocorrect (terminal commands)
  slashMode = 'prompts', // 'prompts' (saved prompts) | 'commands' (Claude Code's TUI slash menu)
  onKeypad, // terminal-only: renders an extra ⌨ button that calls this
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('ask');
  const [showSlash, setShowSlash] = useState(false);
  const [showMore, setShowMore] = useState(false); // ⋯ overflow: permission mode + read-aloud
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const isBusy = busy !== undefined ? busy : session.state === 'busy';
  // Terminal (allowEmptySend) has ONE button that follows the screen: Claude grinding
  // away -> ■ (Esc, interrupt); a question waiting or something typed -> ➤ (Enter/send).
  // A pending prompt still reads as "busy", so it has to override the stop state.
  const showStop = allowEmptySend ? isBusy && !promptPending && !text.trim() : isBusy;

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
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); }
    }, 0);
  }

  function pickCommand(c) {
    setShowSlash(false);
    insert(c.bucket === 'args' ? c.cmd + ' ' : c.cmd);
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
    if (!t && !allowEmptySend) return;
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
        placeholder={placeholder}
        value={text}
        autoCapitalize={plainText ? 'none' : undefined}
        autoCorrect={plainText ? 'off' : undefined}
        autoComplete={plainText ? 'off' : undefined}
        spellCheck={plainText ? false : undefined}
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
        <div className="composer-spacer" />
        <DictationMic className="cbtn" text={text} setText={setText} notify={notify} />
        <button
          className="cbtn"
          onClick={() => setShowSlash(true)}
          aria-label={slashMode === 'commands' ? 'Slash commands' : 'Saved prompts'}
        >
          /
        </button>
        <button className="cbtn" onClick={() => fileRef.current?.click()} aria-label="Attach">📎</button>
        <input ref={fileRef} type="file" onChange={onFile} style={{ display: 'none' }} />
        {onKeypad && (
          <button
            type="button"
            className="cbtn"
            onClick={onKeypad}
            aria-label="Terminal keys"
            title="Terminal key pad — cursors, Enter, Esc, Ctrl"
          >
            ⌨
          </button>
        )}
        {/* Less-used controls (permission mode + read-aloud) tuck behind ⋯ so the bar
            fits on a narrow phone. */}
        <div className="composer-more-wrap">
          <button
            type="button"
            className="cbtn"
            onClick={() => setShowMore((v) => !v)}
            aria-label="More: permission mode and read aloud"
            aria-expanded={showMore}
          >
            ⋯
          </button>
          {showMore && (
            <>
              <div className="composer-more-backdrop" onClick={() => setShowMore(false)} />
              <div className="composer-more" role="menu">
                <button className={'mode-pill mode-' + mode} onClick={cycleMode}>
                  <span className="mode-zap">⚡</span> {MODE_LABEL[mode]}
                </button>
                <button
                  className="composer-more-item"
                  onClick={() => { setShowMore(false); replay('summary'); }}
                >
                  <span className="composer-more-ico">🔊</span> Read summary aloud
                </button>
                <button
                  className="composer-more-item"
                  onClick={() => { setShowMore(false); replay('full'); }}
                >
                  <span className="composer-more-ico">📖</span> Read full reply aloud
                </button>
              </div>
            </>
          )}
        </div>
        {showStop ? (
          <button className="cbtn stop" onClick={stop} aria-label="Stop (Esc)">■</button>
        ) : (
          <button
            className="cbtn send"
            onClick={() => send()}
            disabled={!allowEmptySend && !text.trim()}
            aria-label={allowEmptySend && !text.trim() ? 'Enter' : 'Send'}
          >
            ➤
          </button>
        )}
      </div>

      {showSlash && (
        slashMode === 'commands' ? (
          <SlashCommands onPick={pickCommand} onClose={() => setShowSlash(false)} />
        ) : (
          <PromptsModal currentText={text} onInsert={insert} onClose={() => setShowSlash(false)} notify={notify} />
        )
      )}
    </div>
  );
}
