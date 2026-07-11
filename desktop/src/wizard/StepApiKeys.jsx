import React, { useEffect, useRef, useState } from 'react';
import { saveConfig, listVoices, previewVoiceUrl, configState } from '../lib/api.js';

export default function StepApiKeys({ onNext }) {
  const [openai, setOpenai] = useState('');
  const [eleven, setEleven] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const audioRef = useRef(null);

  useEffect(() => {
    configState()
      .then((s) => {
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
        await saveConfig({ openai_api_key: openai || undefined, elevenlabs_api_key: eleven || undefined });
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

  return (
    <div className="stack">
      <span className="label">Step 1 · API keys</span>
      <h2>Speech &amp; voice keys</h2>
      <p className="muted">Stored locally on this PC (SQLite) and used server-side only — never sent to your phone.</p>

      <label>OpenAI API key <span className="muted">(speech-to-text)</span></label>
      <input type="password" placeholder="sk-…  (blank keeps existing)" value={openai} onChange={(e) => setOpenai(e.target.value)} />

      <label>ElevenLabs API key <span className="muted">(text-to-speech)</span></label>
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
        <button className="primary" onClick={cont} disabled={!voiceId}>Continue</button>
      </div>
    </div>
  );
}
