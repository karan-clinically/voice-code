import React, { useEffect, useState } from 'react';
import { SttModeToggle, SummariseToggle, ElevenVoicePicker, ThemePicker, KeepAwakeToggle } from './components.jsx';
import { pushSupported, notificationsOn, enableNotifications, disableNotifications } from './lib/push.js';
import { apiKeyState, saveApiKeys, pushTest } from './lib/api.js';
import BrainSettings from './BrainSettings.jsx';

// Voice settings, behind the header ☰ menu. Dictation mode + which ElevenLabs
// voice reads replies. Changes are shared harness-side, so they follow you to the
// PC too. Notifications is per-device (a push subscription for this phone).
export default function SettingsModal({ onClose, notify, onProvidersChanged }) {
  return (
    <div className="pm-sheet">
      <div className="pm-sheet-head">
        <div className="sv-title">Settings</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="pm-sheet-list">
        <div className="set-item">
          <strong>Theme</strong>
          <div className="muted">
            Skin the app after a sci-fi film. Tap one to switch instantly — it sticks on this device.
          </div>
          <ThemePicker />
        </div>
        <div className="set-item">
          <strong>Brains</strong>
          <div className="muted">
            Coding agents and their credentials. Add API-backed brains or installed CLIs with OAuth login. The xAI key for Grok belongs here.
          </div>
          <BrainSettings notify={notify} onChanged={onProvidersChanged} />
        </div>
        <div className="set-item">
          <strong>Dictation</strong>
          <div className="muted">
            Batch transcribes when you stop; Live shows words as you speak. Either way the text lands in the box —
            nothing sends until you tap Send.
          </div>
          <SttModeToggle notify={notify} />
        </div>
        <div className="set-item">
          <strong>Rewrite</strong>
          <div className="muted">
            Clean up fixes grammar and filler, near word-for-word. Summarise condenses rambling speech into a tight
            instruction (file names, paths and code are always kept). Review it before you send.
          </div>
          <SummariseToggle notify={notify} />
        </div>
        <div className="set-item">
          <strong>Speech & rewrite services</strong>
          <div className="muted">
            These keys do not add coding brains. They power dictation, spoken replies, and optional text cleanup.
            Saved values are never shown; leave a field blank to keep it.
          </div>
          <ApiKeysSetting notify={notify} />
        </div>
        <div className="set-item">
          <strong>Voice</strong>
          <div className="muted">Which ElevenLabs voice reads replies aloud. Tap Preview to hear it.</div>
          <ElevenVoicePicker notify={notify} />
        </div>
        <div className="set-item">
          <strong>Keep screen awake</strong>
          <div className="muted">
            Hold the screen on while a coding turn is running with Speak replies enabled, and throughout a
            hands-free voice session. This lets the completion arrive and play before the phone sleeps.
          </div>
          <KeepAwakeToggle />
        </div>
        <div className="set-item">
          <strong>Notifications</strong>
          <div className="muted">
            Get a phone notification when a session needs your input, finishes, or errors — even with the app closed.
          </div>
          <NotificationsSetting notify={notify} />
        </div>
        <div className="set-item">
          <strong>App version</strong>
          <div className="muted">
            Which frontend build this device is running. Use it to confirm a fix actually reached the phone
            before testing it.
          </div>
          <BuildStamp />
        </div>
      </div>
    </div>
  );
}

// The bundle hash this page loaded vs. the one the harness serves now. They
// differ whenever an update is pending — the debugging cost of not knowing which
// build a phone is on is high enough to earn a permanent readout.
function BuildStamp() {
  const [served, setServed] = useState(null);
  const loaded = React.useMemo(() => {
    const el = document.querySelector('script[src*="/assets/index-"]');
    return el?.src.match(/index-([A-Za-z0-9_-]+)\.js/)?.[1] || 'dev';
  }, []);
  useEffect(() => {
    let stop = false;
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => !stop && setServed(d.build || null))
      .catch(() => {});
    return () => { stop = true; };
  }, []);
  const stale = served && served !== loaded;
  return (
    <div className="row" style={{ alignItems: 'center', gap: 10 }}>
      <code style={{ fontSize: 12 }}>{loaded}</code>
      {stale ? (
        <button className="ghost" onClick={() => location.reload()}>Update ready — reload</button>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>{served ? 'up to date' : '…'}</span>
      )}
    </div>
  );
}

function ApiKeysSetting({ notify }) {
  const [state, setState] = useState({});
  const [eleven, setEleven] = useState('');
  const [deepgram, setDeepgram] = useState('');
  const [openai, setOpenai] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    apiKeyState().then(setState).catch((e) => notify?.(e.message));
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const next = await saveApiKeys({
        elevenlabs_api_key: eleven,
        deepgram_api_key: deepgram,
        openai_api_key: openai,
      });
      setState(next);
      setEleven('');
      setDeepgram('');
      setOpenai('');
      const names = (next.saved || []).map((k) => ({
        elevenlabs_api_key: 'ElevenLabs',
        deepgram_api_key: 'Deepgram',
        openai_api_key: 'OpenAI',
      }[k] || k));
      setMsg(names.length ? `Saved ${names.join(', ')}.` : 'No changes — blank fields keep existing keys.');
    } catch (e) {
      notify?.(e.message);
    }
    setBusy(false);
  };

  const placeholder = (has, example) => (has ? '•••• saved — blank keeps existing' : example);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <ServiceKeyField
        name="Deepgram"
        endpoint="api.deepgram.com"
        purpose="Live/batch dictation and Aura-2 spoken replies."
        placeholder={placeholder(state.hasDeepgram, 'Deepgram API key')}
        value={deepgram}
        onChange={setDeepgram}
      />
      <ServiceKeyField
        name="ElevenLabs"
        endpoint="api.elevenlabs.io"
        purpose="Optional speech recognition and spoken-reply voices."
        placeholder={placeholder(state.hasElevenLabs, 'ElevenLabs API key')}
        value={eleven}
        onChange={setEleven}
      />
      <ServiceKeyField
        name="OpenAI"
        endpoint="api.openai.com/v1/chat/completions"
        purpose="Optional dictation cleanup and summaries for long spoken replies—not your Codex login."
        placeholder={placeholder(state.hasOpenAI, 'OpenAI API key: sk-…')}
        value={openai}
        onChange={setOpenai}
      />
      <div className="row" style={{ alignItems: 'center' }}>
        <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save service keys'}</button>
        <span className="muted">
          Deepgram {state.hasDeepgram ? '✓' : '—'} · ElevenLabs {state.hasElevenLabs ? '✓' : '—'} · OpenAI {state.hasOpenAI ? '✓' : '—'}
        </span>
      </div>
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}

function ServiceKeyField({ name, endpoint, purpose, placeholder, value, onChange }) {
  return (
    <label className="service-key-field">
      <span className="service-key-title">{name} <code>{endpoint}</code></span>
      <span className="muted">{purpose}</span>
      <input type="password" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function NotificationsSetting({ notify }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();

  useEffect(() => {
    if (supported) notificationsOn().then(setOn).catch(() => {});
  }, [supported]);

  const choose = async (want) => {
    if (want === on || busy) return;
    setBusy(true);
    try {
      if (want) {
        await enableNotifications();
        setOn(true);
      } else {
        await disableNotifications();
        setOn(false);
      }
    } catch (e) {
      notify?.(e.message);
    }
    setBusy(false);
  };

  const test = async () => {
    try {
      const { sent } = await pushTest();
      notify?.(sent ? 'Test notification sent.' : 'No devices subscribed yet — turn notifications on first.');
    } catch (e) {
      notify?.(e.message);
    }
  };

  if (!supported) {
    return (
      <div className="muted">
        This browser can’t do notifications. On iPhone, add the app to your Home Screen first (Share → Add to Home
        Screen), then open it from there.
      </div>
    );
  }
  return (
    <div className="row" style={{ alignItems: 'center', gap: 10 }}>
      <div className="seg" title="Phone notifications for session events">
        <button className={'seg-btn' + (!on ? ' on' : '')} onClick={() => choose(false)} disabled={busy}>Off</button>
        <button className={'seg-btn' + (on ? ' on' : '')} onClick={() => choose(true)} disabled={busy}>On</button>
      </div>
      {on && (
        <button className="ghost" onClick={test} disabled={busy}>Send test</button>
      )}
    </div>
  );
}
