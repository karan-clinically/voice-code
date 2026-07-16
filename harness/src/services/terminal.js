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
const SCROLLBACK = Math.max(5000, Number(process.env.CVH_TERM_SCROLLBACK) || 20000);
// Raw-output replay buffer: kept per session so a newly-connected xterm client
// (desktop /ws/term) can paint the existing screen + scrollback on connect.
const REPLAY_CAP = Math.max(256 * 1024, Number(process.env.CVH_TERM_REPLAY_BYTES) || 1024 * 1024); // bytes retained
const REPLAY_TRIM_AT = Math.floor(REPLAY_CAP * 1.5); // slice back to CAP once we exceed this
// Plain-text live output log for mobile Terminal scrollback. Claude's TUI uses the
// alternate screen, whose xterm buffer only exposes the current viewport, so keep a
// sanitized transcript of bytes as they arrive for sessions that have no JSONL
// transcript/prelude yet.
const TEXT_LOG_CAP = Math.max(256 * 1024, Number(process.env.CVH_TERM_TEXT_LOG_BYTES) || 900 * 1024);
const TEXT_LOG_TRIM_AT = Math.floor(TEXT_LOG_CAP * 1.5);
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

function normalizeTerminalText(text) {
  return String(text || '').replace(/\r?\n/g, '\n').replace(/\n+$/g, '');
}

function withHistoryPrelude(s, body) {
  const parts = [];
  if (s?.terminalPrelude) parts.push(s.terminalPrelude);
  if (s?.terminalLog) parts.push(['===== Live terminal output log =====', s.terminalLog.trimEnd(), '===== Current terminal screen ====='].join('\n'));
  if (!parts.length) return body;
  return [...parts, body].filter(Boolean).join('\n');
}

function terminalDataToText(data) {
  let s = String(data || '');
  // OSC hyperlinks/window-title, CSI cursor/style/control, and simple ESC sequences.
  s = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  s = s.replace(/\x1b[()][A-Za-z0-9]/g, '');
  s = s.replace(/\x1b[=>]/g, '');
  // Convert carriage-return redraws into lines; remove remaining non-printing C0.
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g, '');
  // Apply backspaces within this chunk.
  while (/[^\n]\x08/.test(s)) s = s.replace(/[^\n]\x08/g, '');
  return s;
}

function appendTerminalLog(session, data) {
  const text = terminalDataToText(data);
  if (!text.trim()) return;
  session.terminalLog += text;
  if (session.terminalLog.length > TEXT_LOG_TRIM_AT) {
    session.terminalLog = session.terminalLog.slice(-TEXT_LOG_CAP);
    const firstNl = session.terminalLog.indexOf('\n');
    if (firstNl > 0) session.terminalLog = session.terminalLog.slice(firstNl + 1);
  }
}

function deriveName(cwd, id) {
  const b = cwd ? basename(cwd) : '';
  return b || id;
}

// The harness is usually launched FROM a Claude Code session, so its environment
// carries that parent's child-session markers. Inheriting those makes every claude we
// spawn believe it is a NESTED child: it then never registers in ~/.claude/sessions
// and never opens a remote-control bridge, so the app/phone can't see it and
// `remoteControlAtStartup` is silently ignored. Strip ONLY those markers so each
// session boots as a proper top-level session (and auto-connects RC).
//
// This is an explicit denylist, NOT a `CLAUDE_CODE_*` prefix sweep, on purpose: that
// sweep also deleted CLAUDE_CODE_OAUTH_TOKEN — the long-lived `claude setup-token`
// token — forcing every session back onto the shared, rotating ~/.claude/.credentials
// file, whose single-use refresh token races across concurrent sessions and logs them
// out. Auth and user config (…_OAUTH_TOKEN, …_USE_BEDROCK/VERTEX, CLAUDE_PATH,
// CLAUDE_EFFORT, ANTHROPIC_*) must pass through untouched.
const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
]);
function topLevelEnv(removeEnv = []) {
  const e = { ...process.env };
  for (const k of SESSION_MARKERS) delete e[k];
  for (const k of removeEnv) delete e[k];
  return e;
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
  removeEnv = [],
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  terminalPrelude = '',
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
      env: { ...topLevelEnv(removeEnv), ...env },
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
    replay: '',
    terminalPrelude: normalizeTerminalText(terminalPrelude),
    terminalLog: '',
    cols,
    rows,
  };

  ptyProc.onData((data) => {
    term.write(data);
    session.replay += data;
    appendTerminalLog(session, data);
    if (session.replay.length > REPLAY_TRIM_AT) session.replay = session.replay.slice(-REPLAY_CAP);
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
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return full ? withHistoryPrelude(s, body) : body;
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

// --- colored HTML rendering (preserves the terminal's actual cell colors) ---

const BASE16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
const CUBE = [0, 95, 135, 175, 215, 255];

function palette(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    return rgb(CUBE[Math.floor(i / 36) % 6], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]);
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}
function rgb(r, g, b) {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
function rgbHex(n) {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}
function esc(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
function cellKey(cell) {
  let fg = null;
  let bg = null;
  if (!cell.isFgDefault()) fg = cell.isFgRGB() ? rgbHex(cell.getFgColor()) : palette(cell.getFgColor());
  if (!cell.isBgDefault()) bg = cell.isBgRGB() ? rgbHex(cell.getBgColor()) : palette(cell.getBgColor());
  const bold = cell.isBold ? !!cell.isBold() : false;
  if (cell.isInverse && cell.isInverse()) {
    const t = fg;
    fg = bg || '#0d0d10';
    bg = t || '#cfe3cf';
  }
  return `${fg || ''}|${bg || ''}|${bold ? 1 : 0}`;
}
function spanFor(key, text) {
  const [fg, bg, bold] = key.split('|');
  if (!fg && !bg && bold !== '1') return esc(text);
  let style = '';
  if (fg) style += `color:${fg};`;
  if (bg) style += `background:${bg};`;
  if (bold === '1') style += 'font-weight:700;';
  return `<span style="${style}">${esc(text)}</span>`;
}

// Render the buffer as colored HTML (one <span> run per style change per line),
// capped to the last `maxLines` for payload/perf. Lines joined by \n (client
// renders in a white-space:pre element).
export function captureColoredHtml(id, { full = false, maxLines = 600 } = {}) {
  const s = sessions.get(id);
  if (!s) throw new Error(`session ${id} not found`);
  const term = s.term;
  const buf = term.buffer.active;
  let start = full ? 0 : buf.baseY;
  const end = full ? buf.length : buf.baseY + term.rows;
  if (end - start > maxLines) start = end - maxLines;

  const out = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) {
      out.push('');
      continue;
    }
    let html = '';
    let key = null;
    let run = '';
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      if (cell.getWidth() === 0) continue; // wide-char trailing slot
      const chars = cell.getChars() || ' ';
      const k = cellKey(cell);
      if (k !== key) {
        if (run) html += spanFor(key, run);
        key = k;
        run = '';
      }
      run += chars;
    }
    if (run) html += spanFor(key, run);
    out.push(html.replace(/\s+$/, ''));
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '');
  if (full && (s.terminalPrelude || s.terminalLog)) {
    const parts = [];
    if (s.terminalPrelude) parts.push(esc(s.terminalPrelude));
    if (s.terminalLog) parts.push(esc(['===== Live terminal output log =====', s.terminalLog.trimEnd(), '===== Current terminal screen ====='].join('\n')));
    return [...parts, body].filter(Boolean).join('\n');
  }
  return body;
}

export async function captureColoredHtmlFlushed(id, opts) {
  await flush(id);
  return captureColoredHtml(id, opts);
}

// Raw output retained for this session (for a fresh terminal client to replay).
export function getReplayBuffer(id) {
  const s = sessions.get(id);
  return s ? s.replay : '';
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
  // Idempotent: skip an unchanged resize so re-opening a session (which re-measures
  // and re-fits) can't fire a needless SIGWINCH that disrupts an in-progress
  // operation like /compact.
  if (s.cols === cols && s.rows === rows) return true;
  try {
    s.pty.resize(cols, rows);
    s.term.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
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

// "owner/repo" from a repo's origin remote (like the Claude Code app shows), or
// null when there's no origin / not a repo. Handles both SSH and HTTPS remotes.
export async function getRemoteSlug(cwd) {
  if (!cwd) return null;
  try {
    const { stdout } = await pexecFile('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    const m = stdout.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
