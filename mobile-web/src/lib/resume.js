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
