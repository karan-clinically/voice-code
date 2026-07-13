// hclaude — attach your local terminal to a HARNESS-OWNED Claude Code session.
//
// Why this exists: a Claude session started in a bare terminal is a single-owner
// TUI process that no other device can attach to. So opening it on the phone can
// only `--resume` it into a *second* process — a fork. This wrapper instead asks
// the harness to spawn the session (the harness owns the pty) and pipes your real
// terminal to that pty over /ws/term. Now the SAME session is drivable from the
// terminal, the phone, and the desktop app — no forks.
//
// Modes:
//   (default)        create a new harness-owned session in --cwd (or $PWD) and attach
//   --attach         list live harness sessions and reattach to one (auto-picks if only one)
//   --attach <id>    reattach directly to that harness session id
//
// The PowerShell `claude` alias routes plain interactive launches and `--attach`
// here; every other invocation passes straight through to the real CLI. Exit code
// 3 means "harness offline" so the alias can fall back and never leave you stuck.

import http from 'node:http';
import readline from 'node:readline';
import WebSocket from 'ws';

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:4620';
const DETACH = 0x1c; // Ctrl-\ — leaves the session running for other devices
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const stdin = process.stdin;
const stdout = process.stdout;
const stderr = (s) => process.stderr.write(s);

const argv = process.argv.slice(2);
const attachMode = argv.includes('--attach');
const ci = argv.indexOf('--cwd');
const cwd = ci >= 0 && argv[ci + 1] ? argv[ci + 1] : process.cwd();
// `--attach <id>` reattaches directly; a bare `--attach` picks interactively.
let attachId = null;
if (attachMode) {
  const nxt = argv[argv.indexOf('--attach') + 1];
  if (nxt && /^\d+$/.test(nxt)) attachId = Number(nxt);
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
          } else reject(new Error(`HTTP ${res.statusCode}: ${b}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (p) => request('GET', p);
const post = (p, b) => request('POST', p, b);
const offline = (e) => e.code === 'ECONNREFUSED' || /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/.test(e.message || '');

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// Reattach: choose among live harness sessions (auto-pick when there's just one).
async function pickSession() {
  const { sessions } = await get('/api/sessions/recent');
  const live = sessions.filter((s) => s.kind === 'harness'); // /recent harness rows are alive
  if (!live.length) { stdout.write('No live harness sessions to attach to. Run `claude` to start one.\n'); process.exit(0); }
  if (live.length === 1) return { id: live[0].harnessId, cwd: live[0].cwd, name: live[0].name };
  if (!stdin.isTTY) { stderr('Multiple live sessions — pass one: claude --attach <id>\n'); process.exit(1); }
  stdout.write('Live harness sessions:\n');
  live.forEach((s, i) => stdout.write(`  ${i + 1}. #${s.harnessId}  ${s.name}${s.active ? ' (working)' : ''}  ${dim(s.cwd || '')}\n`));
  const choice = await ask(`Attach to [1-${live.length}]: `);
  const idx = Number(choice) - 1;
  if (!(idx >= 0 && idx < live.length)) { process.stderr.write('Invalid choice.\n'); process.exit(1); }
  return { id: live[idx].harnessId, cwd: live[idx].cwd, name: live[idx].name };
}

async function resolveTarget() {
  if (attachMode) {
    if (attachId != null) {
      const info = await get(`/api/sessions/${attachId}`).catch(() => null);
      if (!info || !info.alive) { stderr(`Session #${attachId} is not live.\n`); process.exit(1); }
      return { id: attachId, cwd: info.cwd, name: info.label, reattach: true };
    }
    return { ...(await pickSession()), reattach: true };
  }
  const session = await post('/api/sessions', { kind: 'claude', cwd });
  return { id: session.id, cwd: session.cwd };
}

let target;
try {
  target = await resolveTarget();
} catch (e) {
  if (offline(e)) process.exit(3); // let the alias fall back to the real CLI
  stderr(`hclaude: ${e.message}\n`);
  process.exit(1);
}

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

const banner = target.reattach
  ? `[voice-harness] reattached to session #${target.id}${target.name ? ` (${target.name})` : ''}. Ctrl-\\ detaches.`
  : `[voice-harness] session #${target.id} in ${target.cwd || cwd} — open it on your phone to share. Ctrl-\\ detaches (session keeps running).`;
stdout.write(dim(banner) + '\r\n');

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/ws/term?session=${target.id}`);

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
    done(0, '\r\n' + dim(`[voice-harness] detached — session #${target.id} still running (reattach with \`claude --attach\`, or open it on your phone).`) + '\r\n');
    return;
  }
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d: chunk.toString('utf8') }));
});
stdout.on('resize', sendResize);
