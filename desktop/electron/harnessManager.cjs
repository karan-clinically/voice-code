// Manages the harness backend as a child process. Runs it with SYSTEM Node
// (not Electron's ELECTRON_RUN_AS_NODE) so the native node-pty/better-sqlite3
// modules use the Node ABI they were built for — no electron-rebuild needed.
// The desktop app communicates with the harness only over localhost HTTP/WS.

const { spawn } = require('node:child_process');
const { createWriteStream, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const MAX_RESTARTS = 3;

class HarnessManager {
  constructor({ repoRoot, port = 4620, onLog = () => {}, onStatus = () => {} }) {
    this.repoRoot = repoRoot;
    this.port = port;
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.proc = null;
    this.restarts = 0;
    this.stopping = false;

    const logDir = join(homedir(), '.claude-voice-harness');
    mkdirSync(logDir, { recursive: true });
    this.logStream = createWriteStream(join(logDir, 'harness.out.log'), { flags: 'a' });
  }

  nodeBin() {
    // Prefer an explicit override, else rely on `node` from PATH (system Node).
    return process.env.HARNESS_NODE || 'node';
  }

  start() {
    if (this.proc) return;
    const entry = join(this.repoRoot, 'harness', 'src', 'index.js');
    this.onStatus('starting');
    this.proc = spawn(this.nodeBin(), [entry], {
      cwd: join(this.repoRoot, 'harness'),
      env: { ...process.env, PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const forward = (buf) => {
      const text = buf.toString();
      this.logStream.write(text);
      this.onLog(text);
    };
    this.proc.stdout.on('data', forward);
    this.proc.stderr.on('data', forward);

    this.proc.on('spawn', () => {
      this.onStatus('running');
    });
    this.proc.on('error', (err) => {
      this.onLog(`[harnessManager] spawn error: ${err.message}\n`);
      this.onStatus('error');
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.onLog(`[harnessManager] harness exited (code=${code})\n`);
      if (this.stopping) {
        this.onStatus('stopped');
        return;
      }
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.onLog(`[harnessManager] restarting (${this.restarts}/${MAX_RESTARTS})\n`);
        setTimeout(() => this.start(), 1000);
      } else {
        this.onStatus('crashed');
      }
    });
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { HarnessManager };
