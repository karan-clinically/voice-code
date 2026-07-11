import React, { useEffect, useRef, useState } from 'react';
import { saveConfig, listVoices, previewVoiceUrl, configState, transcribeAudio } from '../lib/api.js';
import { startRecording } from '../lib/record.js';

export default function StepApiKeys({ onNext }) {
  const [deepgram, setDeepgram] = useState('');
  const [openai, setOpenai] = useState('');
  const [eleven, setEleven] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [sttMode, setSttMode] = useState('batch');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttResult, setSttResult] = useState('');
  const [err, setErr] = useState('');
  const audioRef = useRef(null);

  useEffect(() => {
    configState()
      .then((s) => {
        setHasDeepgram(!!s.hasDeepgram);
        if (s.sttMode) setSttMode(s.sttMode);
        if (s.voiceId) setVoiceId(s.voiceId);
        if (s.hasElevenLabs) loadVoices(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadVoices(skipSave = false) {
    setErr('');
    setBusy(true);
    try {
      if (!skipSave) {
        await saveConfig({
          deepgram_api_key: deepgram || undefined,
          openai_api_key: openai || undefined,
          elevenlabs_api_key: eleven || undefined,
        });
        if (deepgram) setHasDeepgram(true);
      }
      const { voices: v } = await listVoices();
      setVoices(v);
      setLoaded(true);
      setVoiceId((cur) => cur || v[0]?.voice_id || '');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Record 3s from the desktop mic and run a batch transcription so the user can
  // confirm their Deepgram key works before leaving the wizard.
  async function testStt() {
    setErr('');
    setSttResult('');
    try {
      await saveConfig({ deepgram_api_key: deepgram || undefined });
      if (deepgram) setHasDeepgram(true);
    } catch (e) {
      setErr(e.message);
      return;
    }
    setSttBusy(true);
    try {
      const rec = await startRecording();
      await new Promise((r) => setTimeout(r, 3000));
      const blob = await rec.stop();
      const { text } = await transcribeAudio(blob, 'webm', { cleanup: false });
      setSttResult(text ? `“${text}”` : '(no speech detected — try again)');
    } catch (e) {
      setErr('Transcription test failed: ' + e.message);
    } finally {
      setSttBusy(false);
    }
  }

  function chooseMode(m) {
    setSttMode(m);
    saveConfig({ stt_mode: m }).catch((e) => setErr(e.message));
  }

  async function test() {
    setErr('');
    try {
      const url = await previewVoiceUrl(voiceId);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
      }
    } catch (e) {
      setErr('Preview failed: ' + e.message);
    }
  }

  async function cont() {
    setErr('');
    try {
      await saveConfig({ elevenlabs_voice_id: voiceId });
      onNext();
    } catch (e) {
      setErr(e.message);
    }
  }

  const canContinue = !!voiceId && (hasDeepgram || !!deepgram);

  return (
    <div className="stack">
      <span className="label">Step 1 · API keys</span>
      <h2>Speech &amp; voice keys</h2>
      <p className="muted">Stored locally on this PC (SQLite) and used server-side only — never sent to your phone.</p>

      <label>
        Deepgram API key <span className="muted">(speech-to-text)</span>
      </label>
      <input
        type="password"
        placeholder={hasDeepgram ? '•••• (saved — blank keeps existing)' : 'get one free at console.deepgram.com — no card required'}
        value={deepgram}
        onChange={(e) => setDeepgram(e.target.value)}
      />
      <div className="row">
        <button onClick={testStt} disabled={sttBusy || (!deepgram && !hasDeepgram)}>
          {sttBusy ? '🎙 Recording 3s…' : '🎙 Test transcription'}
        </button>
        {sttResult && <span className="muted" style={{ alignSelf: 'center' }}>{sttResult}</span>}
      </div>

      <label>
        Dictation mode <span className="muted">(how voice reaches the command box)</span>
      </label>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button type="button" className={'seg-btn' + (sttMode !== 'stream' ? ' on' : '')} onClick={() => chooseMode('batch')}>
          Batch
        </button>
        <button type="button" className={'seg-btn' + (sttMode === 'stream' ? ' on' : '')} onClick={() => chooseMode('stream')}>
          Live stream
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Batch transcribes the whole clip after you stop; Live stream shows words as you speak. Either way the text lands
        in the box for review — nothing sends until you press Send.
      </p>

      <label>
        OpenAI API key <span className="muted">(optional — dictation cleanup)</span>
      </label>
      <input
        type="password"
        placeholder="sk-…  (optional; blank keeps existing)"
        value={openai}
        onChange={(e) => setOpenai(e.target.value)}
      />

      <label>
        ElevenLabs API key <span className="muted">(text-to-speech)</span>
      </label>
      <input type="password" placeholder="…  (blank keeps existing)" value={eleven} onChange={(e) => setEleven(e.target.value)} />

      <div className="row">
        <button onClick={() => loadVoices(false)} disabled={busy}>
          {busy ? 'Loading…' : 'Save keys & load voices'}
        </button>
      </div>

      {loaded && (
        <>
          <label>Voice</label>
          <div className="row">
            <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button onClick={test} disabled={!voiceId}>▶ Test</button>
          </div>
          <audio ref={audioRef} hidden />
        </>
      )}

      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="primary" onClick={cont} disabled={!canContinue}>Continue</button>
      </div>
    </div>
  );
}
