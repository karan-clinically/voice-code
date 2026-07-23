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
const modeStorageKey = (sessionId) => `cvh_permission_mode:${sessionId}`;
const savedMode = (sessionId) => {
  try {
    const value = localStorage.getItem(modeStorageKey(sessionId));
    return MODES.includes(value) ? value : 'ask';
  } catch {
    return 'ask';
  }
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
  const [mode, setMode] = useState(() => savedMode(session.id));
  const [showSlash, setShowSlash] = useState(false);
  const [showMore, setShowMore] = useState(false); // ⋯ overflow: permission mode + read-aloud
  const [attachments, setAttachments] = useState([]); // visible label -> hidden server path
  const [pendingUploads, setPendingUploads] = useState([]);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const nextUploadNumber = useRef(1);
  const lastPaste = useRef({ text: '', at: 0 });
  const isBusy = busy !== undefined ? busy : session.state === 'busy';
  const isGrok = (session.kind || '') === 'grok';
  const isCodex = (session.kind || '') === 'codex';
  const agentLabel = isCodex ? 'Codex' : isGrok ? 'Grok' : 'Claude';
  // Busy always owns the action button: a draft must never hide the only way to
  // interrupt a running turn. A pending prompt is the exception because Enter/send
  // answers it; the draft stays intact while Stop is visible and returns afterwards.
  const showStop = isBusy && !promptPending;

  // True while a tap's mode switch awaits server confirmation. The 4s poll keeps
  // running during that window, and a poll that left BEFORE the key landed comes
  // back carrying the old mode — letting it setMode would stomp the switch right
  // back (the "toggles then reverts" bug). Gate it out while cycling.
  const cycling = useRef(false);
  const rememberMode = useCallback((next) => {
    if (!MODES.includes(next)) return;
    setMode(next);
    try { localStorage.setItem(modeStorageKey(session.id), next); } catch { /* storage unavailable */ }
  }, [session.id]);
  const refreshMode = useCallback(() => {
    if (isGrok || isCodex || cycling.current) return; // non-Claude agents have no mode footer
    sessionMode(session.id).then((r) => { if (!cycling.current && r?.mode) rememberMode(r.mode); }).catch(() => {});
  }, [session.id, isGrok, isCodex, rememberMode]);

  useEffect(() => {
    setMode(savedMode(session.id));
  }, [session.id]);

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
          rememberMode(m);
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
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const batch = files.map((file) => ({
      id: `${Date.now()}-${nextUploadNumber.current}`,
      label: `Upload ${nextUploadNumber.current++}`,
      file,
      progress: 0,
    }));
    setPendingUploads((prev) => [...prev, ...batch]);
    setUploading(true);
    try {
      const setProgress = (id, progress) => setPendingUploads((prev) => prev.map((item) =>
        item.id === id ? { ...item, progress: Math.max(item.progress, progress) } : item
      ));
      const results = await Promise.allSettled(batch.map((item) =>
        attachFile(session.id, item.file, (progress) => setProgress(item.id, progress))
      ));
      const added = [];
      let failed = 0;
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value?.path) {
          added.push({ label: batch[i].label, path: result.value.path });
        } else {
          failed += 1;
        }
      }
      // Let the fully-coloured label land visibly before it becomes ordinary text.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (added.length) {
        setAttachments((prev) => [...prev, ...added]);
        insert(added.map((item) => `[${item.label}]`).join(' ') + ' ');
      }
      if (failed) notify(`${failed} file${failed === 1 ? '' : 's'} could not be uploaded`);
    } finally {
      const ids = new Set(batch.map((item) => item.id));
      setPendingUploads((prev) => prev.filter((item) => !ids.has(item.id)));
      setUploading(false);
    }
  }

  function onPaste(e) {
    const pasted = e.clipboardData?.getData('text/plain');
    if (!pasted) return;

    // Some mobile browsers dispatch both a clipboard paste and a matching input
    // insertion. Own the insertion here so the clipboard text has one path only.
    e.preventDefault();
    const now = Date.now();
    if (lastPaste.current.text === pasted && now - lastPaste.current.at < 300) return;
    lastPaste.current = { text: pasted, at: now };

    const ta = e.currentTarget;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const next = ta.value.slice(0, start) + pasted + ta.value.slice(end);
    const caret = start + pasted.length;
    setText(next);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.setSelectionRange(caret, caret);
    });
  }

  async function stop() {
    try {
      await sessionKey(session.id, 'stop');
    } catch (e) {
      notify(e.message);
    }
  }

  function send(override) {
    if (uploading) {
      notify('Wait for the files to finish uploading');
      return;
    }
    const visibleText = (typeof override === 'string' ? override : text).trim();
    if (!visibleText && !allowEmptySend) return;
    const expandedText = attachments.reduce((value, item) => {
      const token = `[${item.label}]`;
      const path = `"${String(item.path).replace(/"/g, '\\"')}"`;
      return value.split(token).join(path);
    }, visibleText);
    setText('');
    setAttachments([]);
    nextUploadNumber.current = 1;
    onSubmit(expandedText);
  }

  return (
    <div className="composer">
      {pendingUploads.length > 0 && (
        <div className="composer-upload-progress" aria-live="polite">
          {pendingUploads.map((item) => {
            const text = `[${item.label}]`;
            const completeChars = Math.floor(item.progress * text.length);
            return (
              <span key={item.id} className="composer-upload-token" aria-label={`${item.label} ${Math.round(item.progress * 100)}%`}>
                {Array.from(text).map((char, index) => (
                  <span key={index} className={index < completeChars ? 'uploaded' : ''}>{char}</span>
                ))}
              </span>
            );
          })}
        </div>
      )}
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
        onPaste={onPaste}
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
        <button
          className="cbtn"
          onClick={() => fileRef.current?.click()}
          aria-label={uploading ? 'Uploading files' : 'Attach files'}
          disabled={uploading}
        >
          {uploading ? '…' : '📎'}
        </button>
        <input ref={fileRef} type="file" multiple onChange={onFile} style={{ display: 'none' }} />
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
            disabled={uploading || (!allowEmptySend && !text.trim())}
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
