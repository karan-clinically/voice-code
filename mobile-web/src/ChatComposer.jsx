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
  onLastCommand, // terminal-only: renders a ❯ button that shows your last command
  lastCommandShown = false,
  speakerOn = false,
  onToggleSpeaker,
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState(() => savedMode(session.id));
  const [showModePicker, setShowModePicker] = useState(false);
  const [modeChanging, setModeChanging] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [showMore, setShowMore] = useState(false); // ⋯ overflow: permission mode + read-aloud
  const [attachments, setAttachments] = useState([]); // visible label -> hidden server path
  const [pendingUploads, setPendingUploads] = useState([]);
  // Mobile keyboards can report the same Enter twice: once as keydown and once
  // as an input/change containing a trailing newline. React has not committed
  // setText('') between those events, so both handlers otherwise submit the same
  // draft. Only suppress an identical non-empty submission in this short window;
  // empty double-taps intentionally accept Claude's ghost suggestion.
  const lastSubmit = useRef({ text: '', at: 0 });
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
  async function chooseMode(target) {
    setShowModePicker(false);
    if (!MODES.includes(target) || target === mode || cycling.current) return;
    cycling.current = true;
    setModeChanging(true);
    let current = mode;
    try {
      // Claude exposes this as a Shift+Tab cycle rather than a direct setter.
      // Confirm every step from the actual footer, stopping as soon as the chosen
      // mode lands; this remains correct if Claude changes the cycle order.
      for (let step = 0; step < MODES.length; step += 1) {
        await sessionKey(session.id, 'cycle-mode');
        let next = null;
        for (const wait of [300, 400, 650]) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          const reported = (await sessionMode(session.id))?.mode;
          if (reported && reported !== current) { next = reported; break; }
        }
        if (!next) throw new Error('Mode didn’t switch — try again in a moment');
        current = next;
        rememberMode(current);
        if (current === target) {
          notify(`${MODE_ICON[current]} ${MODE_TOAST[current]}`, 'info');
          return;
        }
      }
      throw new Error(`Could not switch to ${MODE_LABEL[target]}`);
    } catch (e) {
      notify(e.message);
    } finally {
      cycling.current = false;
      setModeChanging(false);
    }
  }

  // 🔊 speaks the short summary; 📖 reads the whole reply. Both go through the
  // harness by session id — it holds the text, strips the markdown, and streams,
  // so a long reply no longer blows /say's length cap the way passing the text up
  // the URL did.
  function replay(mode) {
    if (!lastAssistantText) return notify('Nothing to replay yet');
    try {
      // Same as the speaker button: a refused synthesis must say so rather than
      // play nothing at all.
      playUrl(replyUrl(session.id, mode), { progressive: true, onError: (why) => notify('No speech: ' + why) });
    } catch (e) {
      notify(e.message);
    }
  }

  async function uploadFiles(files, { pasted = false } = {}) {
    files = Array.from(files || []);
    if (!files.length) return;
    if (uploading) return notify('Wait for the current files to finish uploading');
    const batch = files.map((file) => ({
      id: `${Date.now()}-${nextUploadNumber.current}`,
      label: `${pasted ? 'Image' : 'Upload'} ${nextUploadNumber.current++}`,
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

  async function onFile(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files);
  }

  function clipboardImages(data) {
    const out = [];
    for (const item of Array.from(data?.items || [])) {
      if (item.kind !== 'file' || !item.type?.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      // Clipboard blobs are unnamed on some mobile browsers. The attachment API
      // validates extensions, so give every pasted bitmap a safe image filename.
      const subtype = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const ext = subtype === 'jpeg' ? 'jpg' : subtype;
      const name = blob.name && /\.[a-z0-9]+$/i.test(blob.name)
        ? blob.name
        : `pasted-image-${Date.now()}-${out.length + 1}.${ext}`;
      out.push(blob.name === name ? blob : new File([blob], name, { type: blob.type || `image/${ext}` }));
    }
    // Some WebKit builds expose clipboard images through `files` but leave
    // `items` empty. Only use this fallback when the primary list found none so
    // the same bitmap is not uploaded twice.
    if (!out.length) {
      for (const file of Array.from(data?.files || [])) {
        if (file.type?.startsWith('image/')) out.push(file);
      }
    }
    return out;
  }

  function onPaste(e) {
    const images = clipboardImages(e.clipboardData);
    if (images.length) {
      e.preventDefault();
      uploadFiles(images, { pasted: true }).catch((err) => notify('Image paste failed: ' + err.message));
      return;
    }
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
    const now = Date.now();
    if (expandedText && lastSubmit.current.text === expandedText && now - lastSubmit.current.at < 1500) {
      return;
    }
    if (expandedText) lastSubmit.current = { text: expandedText, at: now };
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
        <DictationMic className="cbtn cbtn-driving" text={text} setText={setText} notify={notify} />
        <button
          type="button"
          className={'cbtn cbtn-driving cbtn-speaker' + (speakerOn ? ' on' : '')}
          onClick={onToggleSpeaker}
          aria-label={speakerOn ? 'Turn speaker mode off' : 'Turn speaker mode on and play the latest summary'}
          aria-pressed={speakerOn}
          title={speakerOn ? 'Speaker mode on — tap to stop and turn off' : 'Play latest summary and turn speaker mode on'}
        >
          {speakerOn ? '🔊' : '🔇'}
        </button>
        {/* Voice left, the three pickers centred, send right — a spacer either side
            of the middle group is what holds it there as the bar's width changes. */}
        <div className="composer-spacer" />
        <input ref={fileRef} type="file" multiple onChange={onFile} style={{ display: 'none' }} />
        <button
          type="button"
          className="cbtn"
          onClick={() => setShowSlash(true)}
          aria-label={slashMode === 'commands' ? 'Slash commands' : 'Saved prompts'}
          title={slashMode === 'commands' ? 'Slash commands' : 'Saved prompts'}
        >
          /
        </button>
        <button
          type="button"
          className="cbtn"
          onClick={() => fileRef.current?.click()}
          aria-label={uploading ? 'Uploading files' : 'Attach files'}
          title="Attach files"
          disabled={uploading}
        >
          {uploading ? '…' : '📎'}
        </button>
        {/* What's left behind ⋯: permission mode, terminal keys, the prompt pill,
            read-aloud — settings and one-offs rather than things you reach for
            mid-sentence. */}
        <div className="composer-more-wrap">
          <button
            type="button"
            className="cbtn"
            onClick={() => { setShowModePicker(false); setShowMore((v) => !v); }}
            aria-label="More actions"
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
                {!(isGrok || isCodex) && (
                  <button
                    type="button"
                    className="composer-more-item"
                    onClick={() => { setShowMore(false); setShowModePicker(true); }}
                    disabled={modeChanging}
                  >
                    <span className="composer-more-ico">{modeChanging ? '…' : MODE_ICON[mode]}</span>
                    Permission mode
                    <span className="composer-more-state">{modeChanging ? 'Switching…' : MODE_LABEL[mode]}</span>
                  </button>
                )}
                {onKeypad && (
                  <button
                    type="button"
                    className="composer-more-item"
                    onClick={() => { setShowMore(false); onKeypad(); }}
                  >
                    <span className="composer-more-ico">⌨</span>
                    Terminal keys
                  </button>
                )}
                {onLastCommand && (
                  <button
                    type="button"
                    className="composer-more-item"
                    onClick={() => { setShowMore(false); onLastCommand(); }}
                    aria-pressed={lastCommandShown}
                  >
                    <span className="composer-more-ico">❯</span>
                    {lastCommandShown ? 'Hide your last command' : 'Show your last command'}
                  </button>
                )}
                <button
                  type="button"
                  className="composer-more-item"
                  onClick={() => { setShowMore(false); replay('full'); }}
                >
                  <span className="composer-more-ico">📖</span> Read full reply aloud
                </button>
              </div>
            </>
          )}
          {/* Opened from the ⋯ item above, and anchored here so it rises off the
              same button. The selected target is reached through Claude's Shift+Tab
              cycle. */}
          {showModePicker && !(isGrok || isCodex) && (
            <>
              <div className="composer-more-backdrop" onClick={() => setShowModePicker(false)} />
              <div className="composer-mode-picker" role="menu" aria-label="Permission mode">
                <div className="composer-mode-head">Permission mode</div>
                {MODES.map((item) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={item === mode}
                    className={'composer-mode-option mode-' + item + (item === mode ? ' on' : '')}
                    key={item}
                    onClick={() => chooseMode(item)}
                  >
                    <span className="composer-mode-icon">{MODE_ICON[item]}</span>
                    <span className="composer-mode-copy">
                      <strong>{MODE_LABEL[item]}</strong>
                      <span>{MODE_TOAST[item].split(' — ')[1]}</span>
                    </span>
                    {item === mode && <span className="composer-mode-check">✓</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="composer-spacer" />
        {/* While a turn runs, Send does NOT step aside for Stop — sending mid-turn
            is a real move (the harness queues it, and sending the queued text again
            pushes it into the running turn), and swapping the button away took that
            away exactly when it was wanted. The two share one control instead: same
            height, twice the width, half each, so neither target shrinks. */}
        <div className={'composer-go' + (showStop ? ' running' : '')}>
          <button
            className="cbtn send"
            onClick={() => send()}
            disabled={uploading || (!allowEmptySend && !text.trim())}
            aria-label={allowEmptySend && !text.trim() ? 'Enter' : 'Send'}
          >
            ➤
          </button>
          {showStop && (
            <button className="cbtn stop" onClick={stop} aria-label="Stop (Esc)">■</button>
          )}
        </div>
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
