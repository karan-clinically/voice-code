// Browser-tab indicator for the served dashboard: a coloured favicon dot plus a
// title prefix, so a session that needs you is visible from another Chrome tab.
// The page has no favicon of its own, so the idle icon doubles as its identity.

const BASE_TITLE = 'Claude Code Voice Harness';

// Two states, read at a glance from across the tab strip: green means a session
// wants you (an answer, a decision, a finished turn), black means heads-down —
// working or idle, nothing to do. The title carries which kind it is.
const KIND = {
  input: { label: 'Needs input' },
  failed: { label: 'Failed' },
  finished: { label: 'Finished' },
};
const WAITING_COLOR = '#3fb950';
const WORKING_COLOR = '#0b0f14';

let link = null;
function iconLink() {
  if (link && link.isConnected) return link;
  link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

// 32px is what Chrome asks for on a HiDPI tab strip; anything smaller renders the
// count as mush.
function drawIcon(kind, count) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = kind ? WAITING_COLOR : WORKING_COLOR;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
  ctx.fill();

  // A black disc would disappear into a dark tab strip, so ring it.
  if (!kind) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 2;
    ctx.stroke();
    return canvas.toDataURL('image/png');
  }

  if (count > 1) {
    ctx.fillStyle = '#04140a';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 9 ? '9+' : String(count), size / 2, size / 2 + 1);
  }
  return canvas.toDataURL('image/png');
}

let current = '';

// kind: 'input' | 'failed' | 'finished' | null. `name` titles the single-session
// case — a tab reading "(1) Needs input · Mdp1" says which one without a click.
export function setTabBadge({ kind = null, count = 0, name = '' } = {}) {
  const key = `${kind || ''}|${count}|${name}`;
  if (key === current) return;
  current = key;

  document.title = !kind || count === 0
    ? BASE_TITLE
    : count === 1
      ? `(1) ${KIND[kind].label}${name ? ' · ' + name : ''}`
      : `(${count}) ${KIND[kind].label} +${count - 1}`;

  try {
    iconLink().href = drawIcon(kind, count);
  } catch {
    /* canvas unavailable — the title prefix still carries the signal */
  }
}
