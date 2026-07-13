import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initAudio } from './lib/audio.js';
import { registerSW, syncPushSubscription } from './lib/push.js';
import './styles.css';

initAudio();
registerSW(); // make the app installable + ready the push machinery (idempotent)
syncPushSubscription(); // re-assert this device's push subscription so a rotated/pruned endpoint keeps receiving
createRoot(document.getElementById('root')).render(<App />);
