import React, { useEffect, useRef, useState } from 'react';
import { saveConfig, listVoices, previewVoiceUrl, configState, transcribeAudio } from '../lib/api.js';
import { startRecording } from '../lib/record.js';

export default function StepApiKeys({ onNext }) {
  const [deepgram, setDeepgram] = useState('');
  const [xai, setXai] = useState('');
  const [openai, setOpenai] = useState('');
  const [eleven, setEleven] = useState('');
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [hasXai, setHasXai] = useState(false);
  const [hasEleven, setHasEleven] = useState(false);
  const [sttMode, setSttMode] = useState('batch');

  // The whole loop can run on one vendor, or be mixed. `vendor` is derived UI
  // state; the harness only ever stores stt_provider + tts_provider.
  const [vendor, setVendor] = useState('deepgram');
  const [sttProvider, setSttProvider] = useState('deepgram');

  // TTS: one active provider, each remembering its own voice.
  const [provider, setProvider] = useState('deepgram');
  const [voices, setVoices] = useState([]);
  const [elevenVoice, setElevenVoice] = useState('');
  const [dgVoice, setDgVoice] = useState('');

  const [busy, setBusy] = useState(false);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttResult, setSttResult] = useState('');
  const [err, setErr] = useState('');
  const audioRef = useRef(null);

  const voiceId = provider === 'elevenlabs' ? elevenVoice : dgVoice;
  const setVoiceId = provider === 'elevenlabs' ? setElevenVoice : setDgVoice;

  useEffect(() => {
    configState()
      .then((s) => {
        setHasDeepgram(!!s.hasDeepgram);
        setHasXai(!!s.hasXai);
        setHasEleven(!!s.hasElevenLabs);
        if (s.sttMode) setSttMode(s.sttMode);
        if (s.ttsProvider) setProvider(s.ttsProvider);
        if (s.sttProvider) setSttProvider(s.sttProvider);
        // "All X" when both halves agree, otherwise show the mixed controls.
        if (s.sttProvider && s.ttsProvider) {
          setVendor(s.sttProvider === s.ttsProvider ? s.sttProvider : 'mixed');
        }
        if (s.voiceId) setElevenVoice(s.voiceId);
        if (s.deepgramVoice) setDgVoice(s.deepgramVoice);
        loadVoices(s.ttsProvider || 'deepgram');
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadVoices(p) {
    setErr('');
    try {
      const { voices: v } = await listVoices(p);
      setVoices(v);
      // Adopt the first voice only if this provider has none chosen yet.
      if (p === 'elevenlabs') setElevenVoice((cur) => cur || v[0]?.voice_id || '');
      else setDgVoice((cur) => cur || v[0]?.voice_id || '');
    } catch (e) {
      setVoices([]);
      setErr(e.message);
    }
  }

  async function saveKeys() {
    setErr('');
    setBusy(true);
    try {
      await saveConfig({
        deepgram_api_key: deepgram || undefined,
        xai_api_key: xai || undefined,
        openai_api_key: openai || undefined,
        elevenlabs_api_key: eleven || undefined,
      });
      if (deepgram) setHasDeepgram(true);
      if (xai) setHasXai(true);
      if (eleven) setHasEleven(true);
      // Only a Deepgram key? Then Deepgram is the only provider that can speak.
      const next = !eleven && !hasEleven ? 'deepgram' : provider;
      if (next !== provider) setProvider(next);
      await saveConfig({ tts_provider: next });
      await loadVoices(next);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // One vendor for both halves — a single key and credit pool.
  async function chooseVendor(v) {
    setVendor(v);
    setSttProvider(v);
    setProvider(v);
    setVoices([]);
    try {
      await saveConfig({ stt_provider: v, tts_provider: v });
      await loadVoices(v);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function chooseSttProvider(p) {
    setSttProvider(p);
    try {
      await saveConfig({ stt_provider: p });
    } catch (e) {
      setErr(e.message);
    }
  }

  async function chooseProvider(p) {
    setProvider(p);
    setVoices([]);
    try {
      await saveConfig({ tts_provider: p });
      await loadVoices(p);
    } catch (e) {
      setErr(e.message);
    }
  }

  function chooseSttMode(m) {
    setSttMode(m);
    saveConfig({ stt_mode: m }).catch((e) => setErr(e.message));
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

  // Speak a sample with the currently selected provider + voice.
  async function testVoice() {
    setErr('');
    try {
      const url = await previewVoiceUrl(voiceId, provider);
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
      await saveConfig({
        stt_provider: sttProvider,
        tts_provider: provider,
        elevenlabs_voice_id: elevenVoice || undefined,
        deepgram_tts_voice: dgVoice || undefined,
      });
      onNext();
    } catch (e) {
      setErr(e.message);
    }
  }

  const elevenAvailable = hasEleven || !!eleven;
  const canContinue = (hasDeepgram || !!deepgram) && !!voiceId;

  return (
    <div className="stack">
      <span className="label">Step 1 · API keys</span>
      <h2>Speech &amp; voice keys</h2>
      <p className="muted">Stored locally on this PC (SQLite) and used server-side only — never sent to your phone.</p>

      <label>
        xAI / Grok API key <span className="muted">(native Grok coding sessions)</span>
      </label>
      <input
        type="password"
        placeholder={hasXai ? '•••• (saved — blank keeps existing)' : 'xai-…  (blank if you only use Claude)'}
        value={xai}
        onChange={(e) => setXai(e.target.value)}
      />

      <label>
        Deepgram API key <span className="muted">(speech-to-text, and optionally the voice too)</span>
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
        <button type="button" className={'seg-btn' + (sttMode !== 'stream' ? ' on' : '')} onClick={() => chooseSttMode('batch')}>
          Batch
        </button>
        <button type="button" className={'seg-btn' + (sttMode === 'stream' ? ' on' : '')} onClick={() => chooseSttMode('stream')}>
          Live stream
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Batch transcribes the whole clip when you stop; Live stream shows words as you speak. Either way the text lands
        in the box for review — nothing sends until you press Send.
      </p>

      <label>
        ElevenLabs API key <span className="muted">(optional — only if you want ElevenLabs voices)</span>
      </label>
      <input
        type="password"
        placeholder={hasEleven ? '•••• (saved — blank keeps existing)' : 'optional — Deepgram can do the voice too'}
        value={eleven}
        onChange={(e) => setEleven(e.target.value)}
      />

      <label>
        OpenAI API key <span className="muted">(optional — dictation cleanup)</span>
      </label>
      <input
        type="password"
        placeholder="sk-…  (optional; blank keeps existing)"
        value={openai}
        onChange={(e) => setOpenai(e.target.value)}
      />

      <div className="row">
        <button onClick={saveKeys} disabled={busy}>{busy ? 'Saving…' : 'Save keys'}</button>
      </div>

      <label>
        Run the whole voice loop on <span className="muted">(listening + speaking)</span>
      </label>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button
          type="button"
          className={'seg-btn' + (vendor === 'deepgram' ? ' on' : '')}
          onClick={() => chooseVendor('deepgram')}
          disabled={!hasDeepgram && !deepgram}
        >
          All Deepgram
        </button>
        <button
          type="button"
          className={'seg-btn' + (vendor === 'elevenlabs' ? ' on' : '')}
          onClick={() => chooseVendor('elevenlabs')}
          disabled={!elevenAvailable}
          title={elevenAvailable ? '' : 'Add an ElevenLabs key above'}
        >
          All ElevenLabs
        </button>
        <button
          type="button"
          className={'seg-btn' + (vendor === 'mixed' ? ' on' : '')}
          onClick={() => setVendor('mixed')}
        >
          Mix &amp; match
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Either vendor can do both halves, so you can run on a single key and credit pool. Pick “Mix &amp; match” to
        choose speech-to-text and the voice independently below.
      </p>

      {vendor === 'mixed' && (
        <>
          <label>Speech-to-text</label>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            <button
              type="button"
              className={'seg-btn' + (sttProvider === 'deepgram' ? ' on' : '')}
              onClick={() => chooseSttProvider('deepgram')}
              disabled={!hasDeepgram && !deepgram}
            >
              Deepgram (Nova-3)
            </button>
            <button
              type="button"
              className={'seg-btn' + (sttProvider === 'elevenlabs' ? ' on' : '')}
              onClick={() => chooseSttProvider('elevenlabs')}
              disabled={!elevenAvailable}
            >
              ElevenLabs (Scribe)
            </button>
          </div>
        </>
      )}

      <label>Voice</label>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button
          type="button"
          className={'seg-btn' + (provider === 'deepgram' ? ' on' : '')}
          onClick={() => chooseProvider('deepgram')}
        >
          Deepgram (Aura-2)
        </button>
        <button
          type="button"
          className={'seg-btn' + (provider === 'elevenlabs' ? ' on' : '')}
          onClick={() => chooseProvider('elevenlabs')}
          disabled={!elevenAvailable}
          title={elevenAvailable ? '' : 'Add an ElevenLabs key above to use these voices'}
        >
          ElevenLabs
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        ElevenLabs voices are more expressive and natural. Deepgram Aura-2 is utility-grade — clear and fast, built for
        agent replies rather than narration, and it needs no extra signup (same key and credit as speech-to-text). For
        short spoken summaries, Aura-2 is usually plenty.
      </p>

      <div className="row">
        <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!voices.length}>
          {voices.length === 0 && <option value="">(no voices — save your key first)</option>}
          {voices.map((v) => (
            <option key={v.voice_id} value={v.voice_id}>
              {v.name}
            </option>
          ))}
        </select>
        <button onClick={testVoice} disabled={!voiceId}>▶ Test voice</button>
      </div>
      <audio ref={audioRef} hidden />

      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="primary" onClick={cont} disabled={!canContinue}>Continue</button>
      </div>
    </div>
  );
}
