// Which client this device opens by default. The bare origin ('/') serves a shim
// that reads this key, so a phone lands on the touch UI at /m and a PC on the
// terminal UI at /desktop — and either one can override that guess from its own
// menu. Per-device, like the theme.
const KEY = 'cvh:view';

export function setView(view) {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* private mode — the URL below still switches, it just won't stick */
  }
}

// Remember the choice, then go there. Absolute paths: /m and /desktop are served
// from the same origin, so this works from either client.
export function switchView(view) {
  setView(view);
  location.href = view === 'mobile' ? '/m/' : '/desktop/';
}

// ---------------------------------------------------------------------------
// Phone fit
//
// A phone browser can be told to lay the page out at desktop width — Chrome's
// "Desktop site", which is remembered per site, or a very low per-site page zoom.
// The viewport meta is then ignored: the app is laid out for ~980px and squeezed
// into a ~410px screen, so every control and every line of text reads at about a
// third of its intended size while the layout still fills the width. A page can't
// clear that setting, but it can scale itself back to phone proportions.
// ---------------------------------------------------------------------------

const FIT_KEY = 'cvh:phone-fit'; // 'on' | 'off' | absent = decide per device
const TARGET_WIDTH = 400; // the CSS width the phone layout is drawn for
const WIDE_AT = 620; // beyond this, the viewport is wider than any phone reports

// A touch device laying out at a width no phone has. Enough to offer the fit; not
// enough to apply it uninvited, since a tablet legitimately reports this.
export function wideViewport() {
  if (!window.matchMedia || !matchMedia('(pointer: coarse)').matches) return false;
  return window.innerWidth >= WIDE_AT;
}

// Wide *and* almost certainly a phone in desktop mode: Chrome drops Android from
// the user agent when "Desktop site" is on, while the primary pointer stays
// coarse. A real tablet keeps a mobile or Mac user agent, so it is left alone.
function desktopSiteLikely() {
  if (!wideViewport()) return false;
  const ua = navigator.userAgent;
  return !/Android|iPhone|iPad|iPod|Mobile Safari/i.test(ua) && !/Macintosh|Mac OS X/i.test(ua);
}

export function phoneFitMode() {
  try {
    const v = localStorage.getItem(FIT_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function setPhoneFitMode(mode) {
  try {
    localStorage.setItem(FIT_KEY, mode);
  } catch {
    /* private mode — applies for this visit only */
  }
  applyPhoneFit();
}

export function phoneFitActive() {
  return document.documentElement.classList.contains('phone-fit');
}

// Scale the document up so the layout works out at about a phone's width. The
// class carries CSS overrides for the few rules sized in vh/vw: those units keep
// measuring the unscaled viewport, so a bottom sheet would otherwise run well off
// the screen. --fit-vh is the real viewport height in scaled units.
export function applyPhoneFit() {
  const el = document.documentElement;
  const mode = phoneFitMode();
  const on = mode === 'off' ? false : mode === 'on' ? wideViewport() : desktopSiteLikely();
  if (!on) {
    el.classList.remove('phone-fit');
    el.style.zoom = '';
    el.style.removeProperty('--fit-vh');
    return;
  }
  const z = window.innerWidth / TARGET_WIDTH;
  el.style.zoom = z.toFixed(4);
  el.style.setProperty('--fit-vh', (window.innerHeight / z).toFixed(2) + 'px');
  el.classList.add('phone-fit');
}

// innerWidth is the unscaled layout viewport either way, so re-running this on a
// rotation settles on the new scale without feeding back on itself.
export function initPhoneFit() {
  applyPhoneFit();
  addEventListener('resize', applyPhoneFit);
  addEventListener('orientationchange', applyPhoneFit);
}
