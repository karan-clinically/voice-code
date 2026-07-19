// Presence beacon for the Vercel hub (web/): POST a heartbeat every 30s so the
// hosted UI can show this PC in its AnyDesk-style device list and deep-link
// into the harness when it's online. Opt-in — configure both:
//
//   hub_url   (env HUB_URL)   e.g. https://your-app.vercel.app
//   hub_token (env HUB_TOKEN) the hub's APP_ACCESS_TOKEN
//
// The advertised baseUrl is the tunnel URL if the wizard stored one, else the
// live Tailscale detection. For the phone to launch in from anywhere the
// mapping must be public (tunnel_mode=funnel); a plain tailnet serve URL still
// works when the phone itself is on the tailnet. The pairing token rides along
// so the hub can hand the phone an already-authenticated /m link.

import { hostname } from 'node:os';
import { getConfig } from '../config.js';
import { detectTailscale } from './tunnel.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('hub-presence');
const INTERVAL_MS = 30_000;

let timer = null;
let lastState = null; // 'ok' | 'fail' — log only on transitions, not every beat

async function beat() {
  const hub = getConfig('hub_url');
  const token = getConfig('hub_token');
  if (!hub || !token) return;

  let baseUrl = getConfig('tunnel_url');
  if (!baseUrl) {
    const ts = await detectTailscale(Number(getConfig('port', 4620)));
    baseUrl = ts.baseUrl;
  }
  const name = getConfig('device_name') || hostname();

  try {
    const r = await fetch(new URL('/api/pcs/heartbeat', hub), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: name, name, baseUrl, token: getConfig('pairing_token') || null }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`hub responded ${r.status}`);
    if (lastState !== 'ok') log.info(`heartbeating to ${hub} as "${name}" (${baseUrl || 'no baseUrl'})`);
    lastState = 'ok';
  } catch (err) {
    if (lastState !== 'fail') log.warn(`heartbeat failed: ${err.message} (will keep retrying quietly)`);
    lastState = 'fail';
  }
}

export function startHubPresence() {
  if (!getConfig('hub_url') || !getConfig('hub_token')) {
    log.info('hub presence disabled (set hub_url + hub_token / HUB_URL + HUB_TOKEN to enable)');
    return;
  }
  beat();
  timer = setInterval(beat, INTERVAL_MS);
  timer.unref?.();
}

export function stopHubPresence() {
  if (timer) clearInterval(timer);
  timer = null;
}
