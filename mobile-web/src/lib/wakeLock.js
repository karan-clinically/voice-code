import { useEffect } from 'react';

// Per-device preference (like the theme) for whether hands-free holds the screen
// awake. Defaults ON — absence of the key means enabled — so it keeps the behaviour
// it shipped with; the Settings toggle only exists to turn it off.
const KEY = 'cvh_keepawake';
export const keepAwakeEnabled = () => localStorage.getItem(KEY) !== 'off';
export const setKeepAwake = (on) => localStorage.setItem(KEY, on ? 'on' : 'off');

// Screen Wake Lock: while `active`, ask the browser to keep the screen on so a
// hands-free reply actually plays out loud instead of the phone sleeping mid-turn
// (a slept screen backgrounds the page, which throttles the poll and pauses audio).
//
// The lock auto-releases whenever the tab is hidden — screen off, app backgrounded,
// tab switched — so we re-request it on visibilitychange while still active, and
// release it when `active` goes false or the view unmounts. A no-op where the API
// is absent (older browsers) or the request is refused (e.g. low battery).
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined;
    let sentinel = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible' || sentinel) return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { sentinel = null; });
      } catch {
        /* refused — leave the screen to its normal timeout */
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };

    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { sentinel?.release(); } catch { /* ignore */ }
      sentinel = null;
    };
  }, [active]);
}
