// Live Claude Code sessions, read from Claude's own registry. Every running
// `claude` process writes ~/.claude/sessions/<pid>.json with its session uuid,
// cwd, status (busy|idle) and a heartbeat. These are the sessions the Claude Code
// app shows as "Connected" — including ones started in other terminals and driven
// via claude.ai remote control, which this harness never spawned.
//
// A session file lingers after its process dies, and the heartbeat can be stale
// for a long-idle-but-alive session, so neither the file nor updatedAt alone is a
// reliable "connected" signal. The reliable test is: the recorded pid is still a
// running claude.exe. We get that set from one cached `tasklist` call.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('claude-sessions');
const SESSIONS_DIR = process.env.CVH_CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');

// PIDs currently running as claude.exe. Refreshed in the background so the
// 5s-polled /recent endpoint never blocks on spawning tasklist.
let livePids = new Set();
let pending = false;
let lastRefresh = 0;

function refreshLivePids() {
  if (pending) return;
  pending = true;
  execFile(
    'tasklist',
    ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => {
      pending = false;
      lastRefresh = Date.now();
      if (err) return; // no claude.exe running -> tasklist exits non-zero; leave set as-is briefly
      const set = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^"[^"]*","(\d+)"/); // "claude.exe","1234",...
        if (m) set.add(Number(m[1]));
      }
      livePids = set;
    }
  );
}

// Live Claude sessions whose process is still running. Non-blocking: kicks a
// background PID refresh (throttled) and reads against the last known set.
export function liveClaudeSessions() {
  if (Date.now() - lastRefresh > 4000) refreshLivePids();
  let files;
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!j || !j.sessionId || !livePids.has(j.pid)) continue;
    out.push({
      sessionId: j.sessionId,
      pid: j.pid,
      cwd: j.cwd || null,
      status: j.status || 'idle',
      name: j.name || null,
      startedAt: j.startedAt || null,
      updatedAt: j.updatedAt || j.statusUpdatedAt || j.startedAt || null,
      bridged: !!j.bridgeSessionId,
    });
  }
  return out;
}

// Warm the PID set at boot so the first poll already has data.
refreshLivePids();
