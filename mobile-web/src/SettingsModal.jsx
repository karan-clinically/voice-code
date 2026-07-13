import React, { useEffect, useState } from 'react';
import { SttModeToggle, SummariseToggle, ElevenVoicePicker, ThemePicker } from './components.jsx';
import { pushSupported, notificationsOn, enableNotifications, disableNotifications } from './lib/push.js';
import { pushTest } from './lib/api.js';

// Voice settings, behind the header ☰ menu. Dictation mode + which ElevenLabs
// voice reads replies. Changes are shared harness-side, so they follow you to the
// PC too. Notifications is per-device (a push subscription for this phone).
export default function SettingsModal({ onClose, notify }) {
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
          <strong>Voice</strong>
          <div className="muted">Which ElevenLabs voice reads replies aloud. Tap Preview to hear it.</div>
          <ElevenVoicePicker notify={notify} />
        </div>
        <div className="set-item">
          <strong>Notifications</strong>
          <div className="muted">
            Get a phone notification when a session needs your input, finishes, or errors — even with the app closed.
          </div>
          <NotificationsSetting notify={notify} />
        </div>
      </div>
    </div>
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
