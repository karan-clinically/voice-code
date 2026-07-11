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
