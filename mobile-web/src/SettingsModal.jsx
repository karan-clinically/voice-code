import React from 'react';
import { SttModeToggle, ElevenVoicePicker } from './components.jsx';

// Voice settings, behind the header ☰ menu. Dictation mode + which ElevenLabs
// voice reads replies. Changes are shared harness-side, so they follow you to the
// PC too.
export default function SettingsModal({ onClose, notify }) {
  return (
    <div className="pm-sheet">
      <div className="pm-sheet-head">
        <div className="sv-title">Settings</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="pm-sheet-list">
        <div className="set-item">
          <strong>Dictation</strong>
          <div className="muted">
            Batch transcribes when you stop; Live shows words as you speak. Either way the text lands in the box —
            nothing sends until you tap Send.
          </div>
          <SttModeToggle notify={notify} />
        </div>
        <div className="set-item">
          <strong>Voice</strong>
          <div className="muted">Which ElevenLabs voice reads replies aloud. Tap Preview to hear it.</div>
          <ElevenVoicePicker notify={notify} />
        </div>
      </div>
    </div>
  );
}
