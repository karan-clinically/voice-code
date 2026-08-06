// Per-project app previews. A coding session and its preview are separate
// processes, but sessions in the same cwd share one preview. The app binds to
// localhost and Tailscale Serve supplies the private HTTPS URL used by phones.

import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { promisify } from 'node:util';
import db from '../db.js';
import { getConfig } from '../config.js';
import { addPrivateServeProxy, removePrivateServeProxy, serveHttpsPorts } from './tunnel.js';
import { makeLogger } from '../util/logger.js';

const execFileAsync = promisify(execFile);
const log = makeLogger('preview');
export const previewEvents = new EventEmitter();

const projects = new Map(); // normalized cwd -> internal preview
const projectBySession = new Map(); // session id -> normalized cwd
const reservedLocalPorts = new Set();
const reservedTailscalePorts = new Set();
const routeInsert = db.prepare(`
  INSERT INTO preview_routes(cwd, local_port, tailscale_port, child_pid)
  VALUES(@cwd, @localPort, @tailscalePort, @childPid)
  ON CONFLICT DO UPDATE SET cwd=excluded.cwd,
    local_port=excluded.local_port, tailscale_port=excluded.tailscale_port,
    child_pid=excluded.child_pid,
    created_at=datetime('now')
`);
const routeDelete = db.prepare('DELETE FROM preview_routes WHERE tailscale_port = ?');
const routeAll = db.prepare('SELECT * FROM preview_routes');
const portsGet = db.prepare('SELECT local_port, tailscale_port FROM preview_ports WHERE cwd = ?');
const portsPut = db.prepare(`
  INSERT INTO preview_ports(cwd, local_port, tailscale_port, updated_at)
  VALUES(?, ?, ?, datetime('now'))
  ON CONFLICT(cwd) DO UPDATE SET local_port=excluded.local_port,
    tailscale_port=excluded.tailscale_port, updated_at=excluded.updated_at
`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

const keyOf = (cwd) => resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
const interpolate = (value, port, cwd) => String(value).replaceAll('{port}', String(port)).replaceAll('{cwd}', cwd);

function safeEnvironment(port) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' };
  for (const key of [
    'DEEPGRAM_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY',
    'PAIRING_TOKEN', 'HUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  ]) delete env[key];
  return env;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// Node refuses to spawn .cmd/.bat shims (npm, pnpm, …) without a shell
// (CVE-2024-27980 mitigation), so on Windows preview children run through
// cmd.exe. stopProject taskkills the whole tree, so the extra cmd.exe layer
// is cleaned up with the app.
export function previewSpawn(command, args, options) {
  return spawn(command, args, { ...options, shell: process.platform === 'win32' });
}

export function discoverPreview(cwd) {
  for (const name of ['.voice-harness.json', 'voice-harness.json']) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const value = parsed.preview || parsed;
    if (value.enabled === false) return null;
    if (!value.command || typeof value.command !== 'string') {
      throw new Error(`${name}: preview.command is required`);
    }
    return {
      type: 'process', command: value.command,
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      readyPath: typeof value.readyPath === 'string' ? value.readyPath : '/',
      source: name,
    };
  }

  const packageFile = join(cwd, 'package.json');
  if (existsSync(packageFile)) {
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    if (script) {
      let extra = [];
      if (deps.vite) extra = ['--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'];
      else if (deps.next && script === 'dev') extra = ['--', '-H', '127.0.0.1', '-p', '{port}'];
      return { type: 'process', command: npmCommand(), args: ['run', script, ...extra], readyPath: '/', source: `package.json#${script}` };
    }
  }

  if (existsSync(join(cwd, 'index.html'))) {
    return { type: 'static', readyPath: '/', source: 'index.html' };
  }
  return null;
}

function publicPreview(preview) {
  if (!preview) return null;
  return {
    state: preview.state,
    source: preview.source,
    localUrl: preview.localUrl || null,
    tailscaleUrl: preview.tailscaleUrl || null,
    error: preview.error || null,
  };
}

export function getSessionPreview(sessionId) {
  const key = projectBySession.get(Number(sessionId));
  return key ? publicPreview(projects.get(key)) : null;
}

function changed(preview) {
  for (const sessionId of preview.sessions) previewEvents.emit('change', { sessionId });
}

function availablePort(start, occupied = new Set()) {
  return new Promise((resolvePort, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > start + 199) return reject(new Error('no preview ports available'));
      if (occupied.has(port)) { port += 1; return tryNext(); }
      const server = createNetServer();
      server.unref();
      server.once('error', () => { port += 1; tryNext(); });
      server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(port)));
    };
    tryNext();
  });
}

// Prefer a folder's previously-assigned port so its hosted-app link stays
// stable across restarts; fall back to scanning from `start` when the sticky
// port is taken by something else.
function allocatePort(preferred, start, occupied) {
  if (!preferred || occupied.has(preferred)) return availablePort(start, occupied);
  return new Promise((resolvePort) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => resolvePort(availablePort(start, occupied)));
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolvePort(preferred)));
  });
}

function staticServer(cwd) {
  const root = realpathSync(resolve(cwd));
  return createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (pathname.split('/').some((part) => part.startsWith('.') && part !== '.')) {
      res.writeHead(404).end('Not found'); return;
    }
    const candidate = resolve(root, '.' + pathname);
    if (candidate !== root && !candidate.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
    let file = candidate;
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { /* SPA fallback below */ }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end('Not found'); return; }
    let realFile;
    try { realFile = realpathSync(file); } catch { res.writeHead(404).end('Not found'); return; }
    if (realFile !== root && !realFile.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
    const contentType = MIME[extname(realFile).toLowerCase()];
    if (!contentType) { res.writeHead(404).end('Not found'); return; }
    res.setHeader('Content-Type', contentType);
    createReadStream(realFile).on('error', () => res.writeHead(500).end()).pipe(res);
  });
}

async function waitUntilReady(preview, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const url = new URL(preview.config.readyPath || '/', preview.localUrl).href;
  while (Date.now() < deadline) {
    if (preview.exited) throw new Error(preview.error || 'preview process exited during startup');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return;
    } catch { /* server is still starting */ }
    await new Promise((done) => setTimeout(done, 350));
  }
  throw new Error(`preview did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

async function expose(preview) {
  try {
    preview.tailscaleUrl = await addPrivateServeProxy(preview.localPort, preview.tailscalePort);
    routeInsert.run({
      cwd: preview.cwd, localPort: preview.localPort, tailscalePort: preview.tailscalePort,
      childPid: preview.child?.pid || null,
    });
    return true;
  } catch (err) {
    preview.error = `Local preview is ready; Tailscale exposure failed: ${err.message}`;
    log.warn(`${preview.cwd}: ${preview.error}`);
    return false;
  }
}

export async function startSessionPreview(sessionId, cwd, { force = false } = {}) {
  sessionId = Number(sessionId);
  if (!cwd || (!force && getConfig('preview_auto_start', 'on') === 'off')) return null;
  const key = keyOf(cwd);
  let existing = projects.get(key);
  if (existing) {
    if (force && existing.state === 'ready' && !existing.tailscaleUrl) {
      existing.error = null;
      if (!(await expose(existing))) existing.state = 'error';
      changed(existing);
      return publicPreview(existing);
    }
    if (force && existing.state === 'error') {
      await stopProject(key);
      existing = null;
    }
  }
  if (existing) {
    existing.sessions.add(sessionId);
    projectBySession.set(sessionId, key);
    changed(existing);
    return publicPreview(existing);
  }

  let config;
  try { config = discoverPreview(cwd); }
  catch (err) {
    config = { source: 'configuration', error: err.message };
  }
  if (!config) return null;

  const preview = {
    cwd: resolve(cwd), config, source: config.source, state: 'starting', error: config.error || null,
    localPort: null, tailscalePort: null, localUrl: null, tailscaleUrl: null,
    sessions: new Set([sessionId]), child: null, server: null, exited: false, output: '',
  };
  projects.set(key, preview);
  projectBySession.set(sessionId, key);
  changed(preview);
  if (config.error) { preview.state = 'error'; changed(preview); return publicPreview(preview); }

  try {
    const occupied = await serveHttpsPorts();
    const sticky = portsGet.get(key);
    preview.localPort = await allocatePort(
      sticky?.local_port, Number(getConfig('preview_local_port_start', 5173)), reservedLocalPorts
    );
    reservedLocalPorts.add(preview.localPort);
    preview.tailscalePort = await allocatePort(
      sticky?.tailscale_port,
      Number(getConfig('preview_tailscale_port_start', 10443)),
      new Set([...occupied, ...reservedTailscalePorts])
    );
    reservedTailscalePorts.add(preview.tailscalePort);
    portsPut.run(key, preview.localPort, preview.tailscalePort);
    preview.localUrl = `http://127.0.0.1:${preview.localPort}/`;
    const localPort = preview.localPort;
    if (config.type === 'static') {
      preview.server = staticServer(preview.cwd);
      await new Promise((ok, fail) => {
        preview.server.once('error', fail);
        preview.server.listen(localPort, '127.0.0.1', ok);
      });
    } else {
      const command = process.platform === 'win32' && config.command === 'npm' ? 'npm.cmd' : config.command;
      const args = config.args.map((arg) => interpolate(arg, localPort, preview.cwd));
      preview.child = previewSpawn(command, args, {
        cwd: preview.cwd, env: safeEnvironment(localPort), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const capture = (chunk) => { preview.output = (preview.output + chunk.toString()).slice(-8000); };
      preview.child.stdout?.on('data', capture);
      preview.child.stderr?.on('data', capture);
      preview.child.once('error', (err) => { preview.error = err.message; preview.exited = true; });
      preview.child.once('exit', (code) => {
        preview.exited = true;
        if (preview.state !== 'stopping') {
          preview.state = 'error';
          preview.error = `preview process exited (${code ?? 'unknown'})${preview.output.trim() ? `: ${preview.output.trim().slice(-500)}` : ''}`;
          changed(preview);
        }
      });
    }
    await waitUntilReady(preview);
    if (!(await expose(preview))) throw new Error(preview.error);
    preview.state = 'ready';
    changed(preview);
    log.info(`preview ready for ${preview.cwd}: ${preview.localUrl}${preview.tailscaleUrl ? ` -> ${preview.tailscaleUrl}` : ''}`);
  } catch (err) {
    preview.state = 'error';
    preview.error = err.message;
    changed(preview);
    log.warn(`preview failed for ${preview.cwd}: ${err.message}`);
  }
  return publicPreview(preview);
}

async function stopProject(key) {
  const preview = projects.get(key);
  if (!preview) return;
  preview.state = 'stopping';
  changed(preview);
  preview.server?.close();
  if (preview.child && !preview.exited) {
    if (process.platform === 'win32' && preview.child.pid) {
      await execFileAsync('taskkill', ['/T', '/F', '/PID', String(preview.child.pid)], { windowsHide: true }).catch(() => {});
    } else preview.child.kill('SIGTERM');
  }
  const routeRemoved = preview.tailscalePort == null || await removePrivateServeProxy(preview.tailscalePort);
  if (preview.tailscalePort != null && routeRemoved) routeDelete.run(preview.tailscalePort);
  if (preview.localPort != null) reservedLocalPorts.delete(preview.localPort);
  if (preview.tailscalePort != null) reservedTailscalePorts.delete(preview.tailscalePort);
  projects.delete(key);
  for (const sessionId of preview.sessions) projectBySession.delete(sessionId);
  previewEvents.emit('change', { sessionId: null });
}

export async function stopSessionPreview(sessionId, { force = false } = {}) {
  sessionId = Number(sessionId);
  const key = projectBySession.get(sessionId);
  if (!key) return false;
  const preview = projects.get(key);
  projectBySession.delete(sessionId);
  preview?.sessions.delete(sessionId);
  if (preview && (force || preview.sessions.size === 0)) await stopProject(key);
  else if (preview) changed(preview);
  return true;
}

export async function startPreviewManager() {
  // Only remove ports recorded by this feature. Never reset the user's complete
  // Tailscale configuration because other local services may share it.
  for (const row of routeAll.all()) {
    if (await removePrivateServeProxy(row.tailscale_port)) routeDelete.run(row.tailscale_port);
  }
}

export async function stopAllPreviews() {
  await Promise.all([...projects.keys()].map(stopProject));
}
