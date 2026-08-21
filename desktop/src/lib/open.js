// Open a URL outside the app. Electron hands it to the OS browser through the
// preload bridge; served in a plain browser (harness /desktop) there is no bridge,
// so `window.cvh?.openExternal(url)` silently did nothing — a new tab is the
// equivalent gesture there.
export function openExternal(url) {
  if (!url) return;
  if (window.cvh?.openExternal) {
    window.cvh.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// The hosted-app port is sticky per folder, so showing it tells you which stable
// link this project owns (e.g. ":10444").
export function urlPortLabel(url) {
  try {
    return ':' + new URL(url).port;
  } catch {
    return '';
  }
}
