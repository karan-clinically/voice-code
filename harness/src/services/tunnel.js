// Tunnel provider detection. Only Tailscale is implemented (per plan scope);
// the shape { detect } keeps room for ngrok/Cloudflare later.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { makeLogger } from '../util/logger.js';

const pexec = promisify(execFile);
const log = makeLogger('tunnel');

function tailscaleBin() {
  if (process.env.TAILSCALE_PATH && existsSync(process.env.TAILSCALE_PATH)) return process.env.TAILSCALE_PATH;
  const win = 'C:/Program Files/Tailscale/tailscale.exe';
  if (process.platform === 'win32' && existsSync(win)) return win;
  return 'tailscale';
}

// Re-assert `tailscale serve|funnel --bg <port>` so the harness re-claims the
// root path if something else on the machine repoints it. mode 'funnel' also
// opens the mapping to the PUBLIC internet (funnel implies serve, so tailnet
// clients keep working tokenless) — auth.js requires the pairing token for
// funnel traffic. No-ops/fails quietly if Tailscale isn't present.
export async function ensureServe(port, mode = 'serve') {
  const cmd = mode === 'funnel' ? 'funnel' : 'serve';
  try {
    await pexec(tailscaleBin(), [cmd, '--bg', String(port)], { timeout: 15000 });
    return true;
  } catch (err) {
    log.warn(`tailscale ${cmd} re-pin failed: ${err.message}`);
    return false;
  }
}

// Project previews always use private Serve, even when the phone app itself is
// published with Funnel. A dedicated HTTPS port lets frameworks keep `/` as
// their base path (assets, redirects, service workers, and HMR all keep working).
export async function addPrivateServeProxy(localPort, httpsPort) {
  await pexec(
    tailscaleBin(),
    ['serve', `--https=${Number(httpsPort)}`, '--bg', `http://127.0.0.1:${Number(localPort)}`],
    { timeout: 15000 }
  );
  const detected = await detectTailscale();
  if (!detected.online || !detected.hostname) throw new Error('Tailscale is not online');
  return `https://${detected.hostname}:${Number(httpsPort)}/`;
}

export async function removePrivateServeProxy(httpsPort) {
  try {
    await pexec(tailscaleBin(), ['serve', `--https=${Number(httpsPort)}`, 'off'], { timeout: 15000 });
    return true;
  } catch (err) {
    log.warn(`tailscale preview route cleanup failed on :${httpsPort}: ${err.message}`);
    return false;
  }
}

export async function serveHttpsPorts() {
  try {
    const { stdout } = await pexec(tailscaleBin(), ['serve', 'status', '--json'], { timeout: 5000 });
    const status = JSON.parse(stdout);
    return new Set(Object.keys(status.TCP || {}).map(Number).filter(Number.isFinite));
  } catch {
    return new Set();
  }
}

export async function detectTailscale(port = 4620) {
  try {
    const { stdout } = await pexec(tailscaleBin(), ['status', '--json'], { timeout: 5000 });
    const data = JSON.parse(stdout);
    const self = data.Self || {};
    const dns = (self.DNSName || '').replace(/\.$/, '');
    const ip = (self.TailscaleIPs || [])[0] || null;
    const host = dns || ip;
    return {
      installed: true,
      online: data.BackendState === 'Running',
      hostname: dns || null,
      ip,
      baseUrl: host ? `http://${host}:${port}` : null,
    };
  } catch (err) {
    log.warn(`tailscale detect failed: ${err.message}`);
    return { installed: false, online: false, hostname: null, ip: null, baseUrl: null, error: err.message };
  }
}
