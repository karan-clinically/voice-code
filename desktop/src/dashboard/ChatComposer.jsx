import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionMode, sessionKey, replyUrl, transcribeAudio, configState, sttWsUrl } from '../lib/api.js';
import { startRecording } from '../lib/record.js';
import { speakUrl } from '../lib/speech.js';
import { startSttStream } from '../lib/sttStream.js';
import { clipboardImages, hasImageBridge, uploadImages, pickAttachments, quotePath } from '../lib/attachments.js';
import PromptsModal from './PromptsModal.jsx';

// Permission modes in Shift+Tab cycle order (verified): manual → accept edits →
// plan → auto(full). Labels match the reference app's pill.
const MODES = ['ask', 'auto', 'plan', 'bypass'];
const MODE_LABEL = { ask: 'Ask', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };

// The "code container" chat input: a rounded card with the text field on top and
// a control row (mode pill · mic · replay · "/" prompts · attach · send/stop).
export default function ChatComposer({ session, onSubmit, lastAssistantText, notify }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('ask');
  const [showPrompts, setShowPrompts] = useState(false);
  const [recording, setRecording] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [transcribing, setTranscribing] = useState(false); // mic released, text not back yet
  const [sttMode, setSttMode] = useState('batch');
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const baseRef = useRef('');
  const wroteRef = useRef(null); // the exact string we last put in the box
  const textRef = useRef('');
  const taRef = useRef(null);
  const busy = session.state === 'busy';
  const isGrok = (session.kind || '') === 'grok';
  textRef.current = text;

  useEffect(() => {
    configState().then((s) => s?.sttMode && setSttMode(s.sttMode)).catch(() => {});
  }, []);

  // Merge streamed dictation onto whatever was in the box when the mic opened.
  const applyStream = (t) => {
    const base = baseRef.current;
    const next = base ? base.replace(/\s*$/, '') + ' ' + (t || '') : t || '';
    wroteRef.current = next;
    setText(next);
  };

  // The tidied rewrite arrives ~0.5s after the verbatim text. Only swap it in if
  // the box still holds exactly what we wrote — if you started editing, you win.
  const applyCleaned = (t) => {
    setTidying(false);
    if (textRef.current === wroteRef.current) applyStream(t);
  };

  const refreshMode = useCallback(() => {
    sessionMode(session.id).then((r) => r?.mode && setMode(r.mode)).catch(() => {});
  }, [session.id]);

  useEffect(() => {
    if (isGrok) return undefined; // Grok has no Claude permission-mode footer
    refreshMode();
    const t = setInterval(refreshMode, 4000);
    return () => clearInterval(t);
  }, [refreshMode, isGrok]);

  // Auto-grow the textarea.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  function insert(snippet) {
    setText((prev) => (prev ? prev.replace(/\s*$/, ' ') : '') + snippet);
    taRef.current?.focus();
  }

  async function cycleMode() {
    setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]); // optimistic
    try {
      await sessionKey(session.id, 'cycle-mode');
      setTimeout(refreshMode, 400); // confirm from the TUI
    } catch (e) {
      notify?.('Mode change failed: ' + e.message);
      refreshMode();
    }
  }

  async function toggleMic() {
    // Streaming in progress → stop; the settled text arrives via onFinal.
    if (streamRef.current) {
      const s = streamRef.current;
      streamRef.current = null;
      setRecording(false);
      setTranscribing(true);
      s.stop();
      return;
    }
    // Batch recording in progress → stop and transcribe the whole clip.
    if (recRef.current) {
      const h = recRef.current;
      recRef.current = null;
      setRecording(false);
      setTranscribing(true);
      try {
        const blob = await h.stop();
        const { text: t } = await transcribeAudio(blob, 'webm', { cleanup: true });
        if (t) insert(t);
      } catch (e) {
        notify?.('Voice input failed: ' + e.message);
      } finally {
        setTranscribing(false);
      }
      return;
    }

    if (sttMode === 'stream') {
      baseRef.current = text;
      try {
        streamRef.current = await startSttStream({
          wsUrl: sttWsUrl(),
          onPartial: applyStream,
          onFinal: (t, { tidying: willTidy } = {}) => {
            applyStream(t); // verbatim, instantly
            setTranscribing(false);
            setTidying(!!willTidy);
            taRef.current?.focus();
          },
          onCleaned: applyCleaned,
          onError: async ({ spoken, recovered }) => {
            streamRef.current = null;
            setRecording(false);
            setTranscribing(false);
            setTidying(false);
            notify?.(spoken || 'Voice input failed');
            if (recovered) {
              try {
                const { text: t } = await transcribeAudio(recovered, 'wav', { cleanup: true });
                if (t) applyStream(t);
              } catch {
                /* give up quietly — the spoken error already fired */
              }
            }
          },
        });
        setRecording(true);
      } catch {
        streamRef.current = null;
        notify?.('Microphone unavailable');
      }
      return;
    }

    // Batch mode: record now, transcribe on the next tap.
    try {
      recRef.current = await startRecording();
      setRecording(true);
    } catch {
      notify?.('Microphone unavailable');
    }
  }

  // 🔊 speaks the short summary; 📖 reads the whole reply verbatim. Both are keyed
  // by session so the harness owns the text — it strips the markdown and streams,
  // where passing the raw reply up the URL used to blow /say's length cap.
  function replay(mode) {
    if (!lastAssistantText) return notify?.('Nothing to replay yet');
    try {
      speakUrl(replyUrl(session.id, mode));
    } catch (e) {
      notify?.('Replay failed: ' + e.message);
    }
  }

  async function attach() {
    try {
      const paths = await pickAttachments(session.id);
      if (paths.length) insert(paths.map(quotePath).join(' ') + ' ');
    } catch (e) {
      notify?.('Attach failed: ' + e.message);
    }
  }

  async function pasteImage(e) {
    const images = clipboardImages(e.clipboardData);
    const hasImage = images.length > 0 || Array.from(e.clipboardData?.items || [])
      .some((item) => item.kind === 'file' && item.type?.startsWith('image/'));
    if (!hasImage) return; // let the textarea perform an ordinary text paste
    e.preventDefault();
    try {
      // Electron reads the OS clipboard directly; a served page uploads the pasted
      // bitmap and uses the path the harness stored it at.
      const paths = hasImageBridge()
        ? [(await window.cvh.clipboardImagePath()) || null].filter(Boolean)
        : await uploadImages(session.id, images);
      if (!paths.length) throw new Error('The clipboard image could not be read');
      insert(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' ');
    } catch (err) {
      notify?.('Image paste failed: ' + err.message);
    }
  }

  async function stop() {
    try {
      await sessionKey(session.id, 'stop');
    } catch (e) {
      notify?.('Stop failed: ' + e.message);
    }
  }

  function send() {
    const t = text.trim();
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
        placeholder="Message this session…"
        value={text}
        onPaste={pasteImage}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        {!isGrok && (
          <button className={'mode-pill mode-' + mode} onClick={cycleMode} title="Permission mode — click to cycle (Shift+Tab)">
            <span className="mode-zap">⚡</span> {MODE_LABEL[mode]}
          </button>
        )}
        {isGrok && <span className="mode-pill" title="Native Grok coding agent">Grok</span>}
        <div className="composer-spacer" />
        <button
          className={'cbtn' + (recording ? ' rec' : '') + (transcribing ? ' stt' : '') + (tidying ? ' tidying' : '')}
          onClick={toggleMic}
          disabled={tidying || transcribing}
          aria-busy={transcribing || tidying}
          title={recording ? 'Stop dictating' : transcribing ? 'Transcribing…' : tidying ? 'Tidying up what you said…' : 'Dictate'}
        >
          <span className="cbtn-glyph">{tidying ? '✨' : '🎙'}</span>
        </button>
        <button className="cbtn" onClick={() => replay('summary')} title="Replay the spoken summary">🔊</button>
        <button className="cbtn" onClick={() => replay('full')} title="Read the full reply aloud">📖</button>
        <button className="cbtn" onClick={() => setShowPrompts(true)} title="Saved prompts">/</button>
        <button className="cbtn" onClick={attach} title="Attach a file">📎</button>
        {busy ? (
          <button className="cbtn stop" onClick={stop} title="Stop (interrupt)">■</button>
        ) : (
          <button className="cbtn send" onClick={send} disabled={!text.trim()} title="Send">➤</button>
        )}
      </div>

      {showPrompts && (
        <PromptsModal
          currentText={text}
          onInsert={insert}
          onClose={() => setShowPrompts(false)}
          notify={notify}
        />
      )}
    </div>
  );
}
