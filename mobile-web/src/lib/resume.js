// Mobile browsers resume through different events depending on whether the page
// was merely hidden, frozen, restored from bfcache, or brought back online.
// Coalesce the burst so consumers can safely force one reconnect/refresh.
export function listenForResume(callback) {
  let lastRun = 0;
  const resume = () => {
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastRun < 250) return;
    lastRun = now;
    callback();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', resume);
  return () => {
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('online', resume);
  };
}

// Backstop for a reconnect loop driven by the events above. A phone can deliver
// the resume event BEFORE its radio is back, so the attempt that event triggers
// fails — and if that failure lands while the page momentarily reports hidden
// (iOS flips it around the unlock animation and the app-switcher card), the
// handler that would have armed the retry declines to arm anything, leaving
// nothing scheduled and no further event coming. Recovery has to be an invariant
// re-checked on a timer, not a reaction: while awake, ask the caller "are you
// down?" and let it reconnect. Timers freeze with the tab, so this costs nothing
// while asleep and fires within one interval of waking.
export function watchReconnect(reconnectIfDown, intervalMs = 3000) {
  const timer = setInterval(() => {
    if (!document.hidden) reconnectIfDown();
  }, intervalMs);
  return () => clearInterval(timer);
}
