import React from 'react';
import { SttModeToggle, TtsProviderToggle } from './components.jsx';

// Voice settings, moved off the Home screen behind the header ☰ menu. Same two
// controls (dictation mode + voice vendor) the desktop shares harness-side, so a
// change here follows you to the PC too.
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
          <strong>Voice provider</strong>
          <div className="muted">
            Runs both halves — listening and speaking — on one vendor, so it's a single key and credit pool. Deepgram
            is fast and clear; ElevenLabs is more expressive.
          </div>
          <TtsProviderToggle notify={notify} />
        </div>
      </div>
    </div>
  );
}
