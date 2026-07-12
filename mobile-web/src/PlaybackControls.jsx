import React, { useEffect, useState } from 'react';
import { subscribePlayback, pausePlayback, resumePlayback, skipPlayback } from './lib/audio.js';

// Floating Pause/Skip control for the reply currently playing. Rendered once at the
// app root, it appears on every screen whenever audio is playing (command reply,
// chat replay, hands-free) and hides when nothing is.
export default function PlaybackControls() {
  const [st, setSt] = useState({ playing: false, paused: false });
  useEffect(() => subscribePlayback(setSt), []);
  if (!st.playing) return null;

  return (
    <div className="playbar" role="group" aria-label="Playback controls">
      <span className="playbar-label">{st.paused ? 'Paused' : 'Playing'}</span>
      {st.paused ? (
        <button className="playbar-btn" onClick={resumePlayback} aria-label="Resume">▶ Resume</button>
      ) : (
        <button className="playbar-btn" onClick={pausePlayback} aria-label="Pause">⏸ Pause</button>
      )}
      <button className="playbar-btn" onClick={skipPlayback} aria-label="Skip">⏭ Skip</button>
    </div>
  );
}
