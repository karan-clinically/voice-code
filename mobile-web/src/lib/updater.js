// Keep the phone off a stale bundle — without ever yanking the page mid-flow.
//
// The app is an installed PWA: it holds its loaded page in memory across
// backgrounding, and its app-shell cache is deliberately stale-while-revalidate,
// so a rebuilt frontend could otherwise sit unseen for hours. That gap produced
// three separate "bugs" in a single session — an invisible Enter key, a stale
// sessions list, and a chat that looked lost — all of which were just an old
// bundle. The first fix reloaded on every return to Home, which swapped the
// staleness problem for a flow problem: each shipped build caused a visible
// reload right when the user came back to the app.
//
// Now: detection stays eager, application is polite —
//   * backgrounded (nothing on screen) -> reload immediately, invisibly, unless
//     a message draft would be lost;
//   * foregrounded -> a small "↻ Update ready" pill the user taps whenever;
//   * next backgrounding applies a pending update automatically anyway.

import { jget } from './api.js';

// The bundle this page actually loaded, read off its own <script> tag. Absent on the
// Vite dev server (unhashed), which is the signal to stay out of the way entirely.
const loaded = (() => {
  const el = document.querySelector('script[src*="/assets/index-"]');
  const m = el && el.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : null;
})();

let reloading = false;
let pending = false; // the server has a newer bundle than this page

function draftInComposer() {
  const ta = document.querySelector('.composer-input');
  return !!ta && ta.value.trim() !== '';
}

function applyNow() {
  if (reloading) return;
  reloading = true; // ?s stays in the URL, so a session view returns to the same PTY
  location.reload();
}

function showPill() {
  if (document.getElementById('cvh-update-pill')) return;
  const b = document.createElement('button');
  b.id = 'cvh-update-pill';
  b.type = 'button';
  b.textContent = '↻ Update ready';
  b.title = 'A new version of the app is available — tap to apply';
  b.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)',
    'bottom:calc(env(safe-area-inset-bottom, 0px) + 76px)', 'z-index:9999',
    'padding:8px 14px', 'border-radius:999px',
    'border:1px solid var(--border, #c9c9c9)',
    'background:var(--surface, #ffffff)', 'color:var(--fg, #111111)',
    'font:600 12.5px/1 system-ui, sans-serif',
    'box-shadow:0 4px 14px rgba(0,0,0,0.22)', 'cursor:pointer',
  ].join(';');
  b.addEventListener('click', applyNow);
  document.body.appendChild(b);
}

async function check() {
  if (reloading || !loaded) return;
  if (pending) {
    // Already know about it — just re-offer the pill if it isn't showing.
    if (!document.hidden) showPill();
    return;
  }
  try {
    const { build } = await jget('/api/health');
    if (build && build !== loaded) {
      pending = true;
      if (document.hidden && !draftInComposer()) applyNow(); // invisible apply
      else showPill();
    }
  } catch {
    /* offline / transient — the next check retries */
  }
}

export function startUpdater() {
  if (!loaded) return; // dev server (unhashed bundle): nothing to compare against
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // The moment the user looks away is the free window to apply an update.
      if (pending && !draftInComposer()) applyNow();
    } else {
      check(); // returning is when staleness would bite — detect, offer the pill
    }
  });
  window.addEventListener('focus', check);
  setInterval(check, 60_000);
  check();
}
