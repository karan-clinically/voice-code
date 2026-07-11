// PTY/terminal service — the Windows-native replacement for the plan's tmux.js.
// The harness OWNS each Claude Code session: it spawns `claude` inside a ConPTY
// (via node-pty), feeds the output stream into a headless xterm to keep a clean
// rendered screen (the capture-pane equivalent), and writes text into stdin
// (the send-keys equivalent). No shell is involved, so voice transcripts going
// into a session cannot cause shell injection.

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { makeLogger } from '../util/logger.js';

const { Terminal } = xterm;
const pexecFile = promisify(execFile);
const log = makeLogger('terminal');

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const SCROLLBACK = 5000;
const isWin = process.platform === 'win32';

// events: 'data' {id,data}, 'exit' {id,exitCode}, 'spawn' {id}
export const terminalEvents = new EventEmitter();

const sessions = new Map(); // id -> internal session
let counter = 0;

// Resolve the Claude Code executable. Order: explicit CLAUDE_PATH, the standard
// per-user install location, then bare name (relies on PATH).
export function resolveClaudeCommand() {
  if (process.env.CLAUDE_PATH && existsSync(process.env.CLAUDE_PATH)) return process.env.CLAUDE_PATH;
  const guess = join(homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude');
  if (existsSync(guess)) return guess;
  return isWin ? 'claude.exe' : 'claude';
}

function publicView(s) {
  return {
    id: s.id,
    name: s.name,
    label: s.label,
    cwd: s.cwd,
    command: s.command,
    alive: s.alive,
    pid: s.pid,
    exitCode: s.exitCode ?? null,
    createdAt: s.createdAt,
  };
}

function deriveName(cwd, id) {
  const b = cwd ? basename(cwd) : '';
  return b || id;
}

// Spawn a new session. Defaults to launching Claude Code; pass `command`/`args`
// to run something else (used by tests).
export function spawnSession({
  cwd = process.cwd(),
  command,
  args = [],
  label = null,
  name = null,
  env = {},
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
} = {}) {
  const id = `s${++counter}`;
  const cmd = command || resolveClaudeCommand();
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });

  let ptyProc;
  try {
    ptyProc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...env },
    });
  } catch (err) {
    log.error(`spawn failed for ${cmd}: ${err.message}`);
    throw err;
  }

  const session = {
    id,
    name: name || deriveName(cwd, id),
    label,
    cwd,
    command: cmd,
    pty: ptyProc,
    term,
    alive: true,
    pid: ptyProc.pid,
    exitCode: null,
    createdAt: new Date().toISOString(),
  };

  ptyProc.onData((data) => {
    term.write(data);
    terminalEvents.emit('data', { id, data });
  });
  ptyProc.onExit(({ exitCode }) => {
    session.alive = false;
    session.exitCode = exitCode;
    log.info(`session ${id} exited (code=${exitCode})`);
    terminalEvents.emit('exit', { id, exitCode });
  });

  sessions.set(id, session);
  log.info(`spawned session ${id} cmd=${cmd} cwd=${cwd} pid=${ptyProc.pid}`);
  terminalEvents.emit('spawn', { id });
  return publicView(session);
}

// Write text into a session's stdin. Strips C0 control chars (defense-in-depth
// against untrusted transcripts) and submits with a carriage return after a
// short delay so the Ink-based TUI registers the input before Enter.
export async function sendText(id, text, { submit = true, submitDelayMs = 80 } = {}) {
  const s = sessions.get(id);
  if (!s) throw new Error(`session ${id} not found`);
  if (!s.alive) throw new Error(`session ${id} is dead`);
  const clean = String(text).replace(/[\x00-\x1F\x7F]/g, '');
  s.pty.write(clean);
  if (submit) {
    await delay(submitDelayMs);
    s.pty.write('\r');
  }
}

// Send a raw key sequence (e.g. control chars) without sanitising — for TUI
// control like Escape. Not used for transcript text.
export function sendRaw(id, seq) {
  const s = sessions.get(id);
  if (!s || !s.alive) throw new Error(`session ${id} not found or dead`);
  s.pty.write(seq);
}

// Rendered screen text. full=true includes scrollback (capture-pane -S), else
// just the current viewport.
export function captureScreen(id, { full = true } = {}) {
  const s = sessions.get(id);
  if (!s) throw new Error(`session ${id} not found`);
  const buf = s.term.buffer.active;
  const start = full ? 0 : buf.baseY;
  const end = full ? buf.length : buf.baseY + s.term.rows;
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// Ensure all queued writes are parsed into the buffer before capturing.
export function flush(id) {
  return new Promise((resolve) => {
    const s = sessions.get(id);
    if (!s) return resolve();
    s.term.write('', () => resolve());
  });
}

export async function captureScreenFlushed(id, opts) {
  await flush(id);
  return captureScreen(id, opts);
}

export function listSessions() {
  return [...sessions.values()].map(publicView);
}

export function getSession(id) {
  const s = sessions.get(id);
  return s ? publicView(s) : null;
}

export function sessionExists(id) {
  const s = sessions.get(id);
  return !!(s && s.alive);
}

export function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || !s.alive) return false;
  try {
    s.pty.resize(cols, rows);
    s.term.resize(cols, rows);
    return true;
  } catch (err) {
    log.warn(`resize failed for ${id}: ${err.message}`);
    return false;
  }
}

export function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
  s.alive = false;
  return true;
}

export function killAll() {
  for (const id of sessions.keys()) killSession(id);
}

// git repo name + branch for a working directory. execFile with an argument
// array — no shell interpolation. Returns nulls when not a repo.
export async function getGitInfo(cwd) {
  if (!cwd) return { repo: null, branch: null };
  try {
    const { stdout: top } = await pexecFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    const repoPath = top.trim();
    const repo = repoPath ? basename(repoPath) : null;
    let branch = null;
    try {
      const { stdout: b } = await pexecFile('git', ['-C', cwd, 'branch', '--show-current']);
      branch = b.trim() || null;
    } catch {
      /* detached HEAD or no branch */
    }
    return { repo, branch };
  } catch {
    return { repo: null, branch: null };
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
