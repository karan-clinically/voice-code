import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initAudio } from './lib/audio.js';
import { registerSW, syncPushSubscription } from './lib/push.js';
import { applyTheme, getTheme } from './lib/theme.js';
import './styles.css';

applyTheme(getTheme()); // paint the saved sci-fi skin before first render (no flash)
initAudio();
registerSW(); // make the app installable + ready the push machinery (idempotent)
syncPushSubscription(); // re-assert this device's push subscription so a rotated/pruned endpoint keeps receiving
createRoot(document.getElementById('root')).render(<App />);
