// Movie-themed sci-fi skins. The whole app is driven by CSS custom properties on
// :root (see styles.css), so a theme is just a set of variable overrides under a
// [data-theme] attribute. Switching = flip the attribute → the cascade repaints
// instantly, no reload. Persisted per-device in localStorage (a purely visual
// preference for THIS screen — unlike the voice settings, it isn't shared harness-side).
//
// Each entry carries a few colours purely so the Settings picker can draw a live
// swatch; the real palette lives in the matching CSS block. `neon` adds glow to
// accent controls, `scan` overlays CRT scanlines (see [data-neon] / [data-scan]).

const KEY = 'cvh_theme';

export const THEMES = [
  {
    id: 'pearls', name: 'Pearls', tag: 'Default · light',
    neon: false, scan: false, meta: '#1a4b40',
    bg: '#fafafa', surface: '#ffffff', border: '#e5e5e5',
    text: '#171717', muted: '#737373', accent: '#1a4b40',
  },
  {
    id: 'matrix', name: 'The Matrix', tag: 'Digital rain',
    neon: true, scan: true, meta: '#000600',
    bg: '#000600', surface: '#04120a', border: '#0d3d22',
    text: '#5cff8f', muted: '#1f7a45', accent: '#00ff41',
  },
  {
    id: 'tron', name: 'Tron', tag: 'The Grid',
    neon: true, scan: true, meta: '#01060d',
    bg: '#01060d', surface: '#061420', border: '#0d3350',
    text: '#cdeeff', muted: '#3a7d9c', accent: '#00e5ff',
  },
  {
    id: 'bladerunner', name: 'Blade Runner', tag: 'Neon noir',
    neon: true, scan: false, meta: '#0a0806',
    bg: '#0a0806', surface: '#16100a', border: '#3a2a17',
    text: '#ffd9a0', muted: '#9c7a4a', accent: '#ff7a1a',
  },
  {
    id: 'dune', name: 'Dune', tag: 'Arrakis',
    neon: false, scan: false, meta: '#c9b184',
    bg: '#c9b184', surface: '#dbc9a4', border: '#a98f66',
    text: '#2e2213', muted: '#6b5636', accent: '#a8451a',
  },
  {
    id: 'nostromo', name: 'Nostromo', tag: 'Alien · amber CRT',
    neon: true, scan: true, meta: '#0d0a02',
    bg: '#0d0a02', surface: '#181206', border: '#4a3812',
    text: '#ffb000', muted: '#9c6f14', accent: '#ffb000',
  },
];

export function getTheme() {
  try {
    const id = localStorage.getItem(KEY);
    if (id && THEMES.some((t) => t.id === id)) return id;
  } catch { /* private mode / no storage */ }
  return 'pearls';
}

// Flip the attributes the CSS keys off, update the browser-chrome colour, persist.
export function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const el = document.documentElement;
  el.setAttribute('data-theme', t.id);
  el.toggleAttribute('data-neon', !!t.neon);
  el.toggleAttribute('data-scan', !!t.scan);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.meta || t.bg);
  try { localStorage.setItem(KEY, t.id); } catch { /* ignore */ }
  return t.id;
}
