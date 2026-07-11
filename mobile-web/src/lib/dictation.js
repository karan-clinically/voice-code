// Voice input that ALWAYS ends in the caller's text box — it never sends. Batch
// mode transcribes the whole clip when you tap again; stream mode opens /ws/stt
// and renders interim words live as you speak. The mode is read fresh from the
// harness on each mic press, so flipping the toggle takes effect immediately.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSttMode, sttWsUrl, transcribe } from './api.js';
import { tapRecord } from './audio.js';
import { startSttStream } from './sttStream.js';

export function useDictation({ text, setText, notify }) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const baseRef = useRef('');
  const textRef = useRef('');
  textRef.current = text;

  // Merge dictation onto whatever was in the box when the mic opened.
  const apply = useCallback(
    (t) => {
      const b = baseRef.current;
      setText(b ? b.replace(/\s*$/, '') + ' ' + (t || '') : t || '');
    },
    [setText]
  );

  // Drop the mic if the view unmounts mid-utterance.
  useEffect(
    () => () => {
      streamRef.current?.abort();
      recRef.current?.stop();
    },
    []
  );

  const toggle = useCallback(async () => {
    if (streamRef.current) {
      const s = streamRef.current;
      streamRef.current = null;
      setRecording(false);
      s.stop(); // settled text arrives via onFinal
      return;
    }
    if (recRef.current) {
      const r = recRef.current;
      recRef.current = null;
      setRecording(false);
      r.stop(); // tapRecord's onDone transcribes the clip
      return;
    }

    baseRef.current = textRef.current;
    const mode = await getSttMode().catch(() => 'batch');

    if (mode === 'stream') {
      try {
        streamRef.current = await startSttStream({
          wsUrl: sttWsUrl(),
          onPartial: apply,
          onFinal: apply,
          onError: async ({ spoken, recovered }) => {
            streamRef.current = null;
            setRecording(false);
            notify?.(spoken || 'Voice input failed');
            if (recovered) {
              try {
                const t = (await transcribe(recovered, 'webm')).trim();
                if (t) apply(t);
              } catch {
                /* the spoken error already fired */
              }
            }
          },
        });
        setRecording(true);
      } catch (e) {
        streamRef.current = null;
        notify?.(e.message || 'Microphone unavailable');
      }
      return;
    }

    const h = await tapRecord(async (blob, ext) => {
      recRef.current = null;
      setRecording(false);
      try {
        const t = (await transcribe(blob, ext)).trim();
        if (t) apply(t);
      } catch (e) {
        notify?.(e.message);
      }
    }, notify);
    if (h) {
      recRef.current = h;
      setRecording(true);
    }
  }, [apply, notify]);

  return { recording, toggle };
}
