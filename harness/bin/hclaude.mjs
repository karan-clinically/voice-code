// hclaude — attach your local terminal to a HARNESS-OWNED Claude Code session.
//
// Why this exists: a Claude session started in a bare terminal is a single-owner
// TUI process that no other device can attach to. So opening it on the phone can
// only `--resume` it into a *second* process — a fork. This wrapper instead asks
// the harness to spawn the session (the harness owns the pty) and pipes your real
// terminal to that pty over /ws/term. Now the SAME session is drivable from the
// terminal, the phone, and the desktop app — no forks.
//
// The PowerShell `claude` alias routes plain interactive launches here; every
// other invocation (subcommands, -p, --resume, --version) passes straight through
// to the real CLI. Exit code 3 signals "harness offline" so the alias can fall
// back to real `claude` and never leave you blocked.
//
// Usage: node hclaude.mjs [--cwd <dir>]   (HARNESS_URL overrides the default host)

import http from 'node:http';
import WebSocket from 'ws';

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:4620';
const DETACH = 0x1c; // Ctrl-\ — leaves the session running for other devices
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// --cwd <dir>, else the current directory.
const argv = process.argv.slice(2);
const ci = argv.indexOf('--cwd');
const cwd = ci >= 0 && argv[ci + 1] ? argv[ci + 1] : process.cwd();

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(BASE + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
          } else reject(new Error(`HTTP ${res.statusCode}: ${b}`));
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const offline = (e) => e.code === 'ECONNREFUSED' || /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/.test(e.message || '');

let session;
try {
  session = await post('/api/sessions', { kind: 'claude', cwd });
} catch (e) {
  if (offline(e)) process.exit(3); // let the alias fall back to the real CLI
  process.stderr.write(`hclaude: could not start harness session: ${e.message}\n`);
  process.exit(1);
}

const stdin = process.stdin;
const stdout = process.stdout;
let ended = false;

function cleanup() {
  try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* not a tty */ }
  stdin.pause();
}
function done(code, msg) {
  if (ended) return;
  ended = true;
  try { ws.close(); } catch { /* already closed */ }
  cleanup();
  if (msg) stdout.write(msg);
  process.exit(code);
}

function sendResize() {
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: stdout.columns || 80, rows: stdout.rows || 24 }));
}

stdout.write(dim(`[voice-harness] session #${session.id} in ${session.cwd || cwd} — open it on your phone to share. Ctrl-\\ detaches (session keeps running).`) + '\r\n');

const wsUrl = BASE.replace(/^http/, 'ws') + `/ws/term?session=${session.id}`;
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  sendResize();
});

ws.on('message', (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.t === 'data') stdout.write(m.d);
  else if (m.t === 'exit') done(0, '\r\n' + dim('[voice-harness] session ended.') + '\r\n');
});

ws.on('error', (e) => done(1, '\r\n' + dim(`[voice-harness] connection error: ${e.message}`) + '\r\n'));
ws.on('close', () => done(0));

stdin.on('data', (chunk) => {
  if (chunk.length === 1 && chunk[0] === DETACH) {
    done(0, '\r\n' + dim(`[voice-harness] detached — session #${session.id} still running (open it on your phone or desktop app).`) + '\r\n');
    return;
  }
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d: chunk.toString('utf8') }));
});

stdout.on('resize', sendResize);
