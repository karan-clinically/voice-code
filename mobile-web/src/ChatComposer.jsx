import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionMode, sessionKey, attachFile, replyUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic } from './components.jsx';
import PromptsModal from './PromptsModal.jsx';
import SlashCommands from './SlashCommands.jsx';

const MODES = ['ask', 'auto', 'plan', 'bypass'];
const MODE_LABEL = { ask: 'Ask', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
// Row-button glyphs — the mode switcher sits in the control row (the phone's
// Shift+Tab), so each mode needs a shape you can tell apart at a glance.
const MODE_ICON = { ask: '🛡', auto: '✏️', plan: '🗺', bypass: '⚡' };
const MODE_TOAST = {
  ask: 'Ask — confirms before acting',
  auto: 'Auto — accepts edits',
  plan: 'Plan — read-only, plans first',
  bypass: 'Bypass — no permission prompts',
};

// The "code container" input (phone): rounded card with the text field on top and
// a control row — mic · "/" · attach · mode · ⋯ · send/stop. The mode button is the
// phone's Shift+Tab (tap to cycle permission modes, toast on switch); less-used
// controls (🔊/📖 read-aloud) live behind the ⋯ overflow so the bar fits a narrow
// phone. Shared by Chat and Terminal so both views are identical.
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
  const isGrok = (session.kind || '') === 'grok';
  const isCodex = (session.kind || '') === 'codex';
  const agentLabel = isCodex ? 'Codex' : isGrok ? 'Grok' : 'Claude';
  // Terminal (allowEmptySend) has ONE button that follows the screen: Claude grinding
  // away -> ■ (Esc, interrupt); a question waiting or something typed -> ➤ (Enter/send).
  // A pending prompt still reads as "busy", so it has to override the stop state.
  const showStop = allowEmptySend ? isBusy && !promptPending && !text.trim() : isBusy;

  // True while a tap's mode switch awaits server confirmation. The 4s poll keeps
  // running during that window, and a poll that left BEFORE the key landed comes
  // back carrying the old mode — letting it setMode would stomp the switch right
  // back (the "toggles then reverts" bug). Gate it out while cycling.
  const cycling = useRef(false);
  const refreshMode = useCallback(() => {
    if (isGrok || isCodex || cycling.current) return; // non-Claude agents have no mode footer
    sessionMode(session.id).then((r) => { if (!cycling.current && r?.mode) setMode(r.mode); }).catch(() => {});
  }, [session.id, isGrok, isCodex]);

  useEffect(() => {
    if (isGrok || isCodex) return undefined;
    refreshMode();
    const t = setInterval(refreshMode, 4000);
    return () => clearInterval(t);
  }, [refreshMode, isGrok, isCodex]);

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

  // Confirmed, not optimistic: send the key, then poll until the TUI footer
  // actually reports a different mode (idle and busy sessions both flip within
  // ~300ms), and only then move the icon + toast. An optimistic flip here lied
  // whenever an in-flight background poll raced the tap and reverted it.
  async function cycleMode() {
    if (cycling.current) return; // one confirmed step per tap
    cycling.current = true;
    const prev = mode;
    try {
      await sessionKey(session.id, 'cycle-mode');
      for (const wait of [350, 450, 700]) {
        await new Promise((r) => setTimeout(r, wait));
        const m = (await sessionMode(session.id))?.mode;
        if (m && m !== prev) {
          setMode(m);
          notify(`${MODE_ICON[m]} ${MODE_TOAST[m]}`, 'info');
          return;
        }
      }
      notify('Mode didn’t switch — try again in a moment');
    } catch (e) {
      notify(e.message);
    } finally {
      cycling.current = false;
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
        {/* Permission-mode switcher — the phone's Shift+Tab. One tap cycles
            Ask → Auto → Plan → Bypass; the glyph + tint show the current mode and a
            toast announces each switch. First-class in the row (not in ⋯) because
            mode changes are frequent mid-conversation. */}
        {!(isGrok || isCodex) && (
          <button
            type="button"
            className={'cbtn cbtn-mode mode-' + mode}
            onClick={cycleMode}
            aria-label={`Permission mode: ${MODE_LABEL[mode]} — tap to cycle`}
            title={`${MODE_LABEL[mode]} mode — tap to cycle (Shift+Tab)`}
          >
            {MODE_ICON[mode]}
          </button>
        )}
        {/* Less-used controls (read-aloud) tuck behind ⋯ so the bar fits a narrow
            phone. */}
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
                {(isGrok || isCodex) && (
                  <div className="mode-pill" title={`${agentLabel} terminal session`}>{agentLabel}</div>
                )}
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
