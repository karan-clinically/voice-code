// Keep the phone off a stale bundle.
//
// The app is an installed PWA: it holds its loaded page in memory across
// backgrounding, and the service worker caches nothing (it's push-only), so a
// rebuilt frontend could sit unseen for hours. That one gap produced three separate
// "bugs" in a single session — an invisible Enter key, a stale sessions list, and a
// chat that looked lost — all of which were just an old bundle.
//
// Fix: compare the hashed bundle THIS page loaded against the one the server is
// serving now, and reload when they diverge. Checked when the app returns to the
// foreground (exactly when the staleness bites) and on a slow background poll.

import { jget } from './api.js';

// The bundle this page actually loaded, read off its own <script> tag. Absent on the
// Vite dev server (unhashed), which is the signal to stay out of the way entirely.
const loaded = (() => {
  const el = document.querySelector('script[src*="/assets/index-"]');
  const m = el && el.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : null;
})();

let reloading = false;

// Never yank the page out from under a half-typed message — retry on the next tick.
function midSentence() {
  const ta = document.querySelector('.composer-input');
  return !!ta && (ta.value.trim() !== '' || document.activeElement === ta);
}

async function check() {
  if (reloading || !loaded || midSentence()) return;
  try {
    const { build } = await jget('/api/health');
    if (build && build !== loaded) {
      reloading = true; // a rebuild shipped — pick it up
      location.reload();
    }
  } catch {
    /* offline / transient — the next check retries */
  }
}

export function startUpdater() {
  if (!loaded) return; // dev server (unhashed bundle): nothing to compare against
  // Returning to the app is the moment staleness shows. iOS fires these two
  // inconsistently for an installed PWA, so listen for both — check() is cheap and
  // self-guarding, and a duplicate call is harmless.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
  window.addEventListener('focus', check);
  setInterval(check, 60_000);
  check();
}
