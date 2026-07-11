import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionMode, sessionKey, ttsSayUrl, transcribeAudio, configState, sttWsUrl } from '../lib/api.js';
import { startRecording } from '../lib/record.js';
import { startSttStream } from '../lib/sttStream.js';
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
  const [sttMode, setSttMode] = useState('batch');
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const baseRef = useRef('');
  const wroteRef = useRef(null); // the exact string we last put in the box
  const textRef = useRef('');
  const taRef = useRef(null);
  const busy = session.state === 'busy';
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
    refreshMode();
    const t = setInterval(refreshMode, 4000);
    return () => clearInterval(t);
  }, [refreshMode]);

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
      s.stop();
      return;
    }
    // Batch recording in progress → stop and transcribe the whole clip.
    if (recRef.current) {
      const h = recRef.current;
      recRef.current = null;
      setRecording(false);
      try {
        const blob = await h.stop();
        const { text: t } = await transcribeAudio(blob, 'webm', { cleanup: true });
        if (t) insert(t);
      } catch (e) {
        notify?.('Voice input failed: ' + e.message);
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
            setTidying(!!willTidy);
            taRef.current?.focus();
          },
          onCleaned: applyCleaned,
          onError: async ({ spoken, recovered }) => {
            streamRef.current = null;
            setRecording(false);
            setTidying(false);
            notify?.(spoken || 'Voice input failed');
            if (recovered) {
              try {
                const { text: t } = await transcribeAudio(recovered, 'webm', { cleanup: true });
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

  async function replay() {
    if (!lastAssistantText) return notify?.('Nothing to replay yet');
    try {
      new Audio(ttsSayUrl(lastAssistantText)).play().catch(() => {});
    } catch (e) {
      notify?.('Replay failed: ' + e.message);
    }
  }

  async function attach() {
    try {
      const path = (await window.cvh?.pickFile?.()) || null;
      if (path) insert(/\s/.test(path) ? `"${path}" ` : `${path} `);
    } catch (e) {
      notify?.('Attach failed: ' + e.message);
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <button className={'mode-pill mode-' + mode} onClick={cycleMode} title="Permission mode — click to cycle (Shift+Tab)">
          <span className="mode-zap">⚡</span> {MODE_LABEL[mode]}
        </button>
        <div className="composer-spacer" />
        <button
          className={'cbtn' + (recording ? ' rec' : '') + (tidying ? ' tidying' : '')}
          onClick={toggleMic}
          disabled={tidying}
          title={recording ? 'Stop dictating' : tidying ? 'Tidying up what you said…' : 'Dictate'}
        >
          {tidying ? '✨' : '🎙'}
        </button>
        <button className="cbtn" onClick={replay} title="Replay last reply aloud">🔊</button>
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
