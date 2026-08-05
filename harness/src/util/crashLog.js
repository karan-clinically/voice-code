// Synchronous, dependency-free crash forensics. The harness has died with exit
// code 1 and NOTHING in harness.out.log — pino buffers async and SQLite lives on
// the (possibly broken) main path, so both can lose the final words of a dying
// process. This appender uses fs.appendFileSync straight to
// <DATA_DIR>/crash.log: no imports beyond node:fs/os/path, safe to call from
// exit handlers, worker threads, and half-torn-down states.
//
// Every process exit stamps a line here (see index.js), so "the harness
// restarted and no one knows why" is no longer a possible outcome: an exit with
// no preceding uncaughtException/watchdog line is an external kill (OOM,
// TerminateProcess, supervisor) rather than a JS error.

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mirrors db.js — duplicated on purpose so crash logging never depends on the
// DB module loading successfully.
const DATA_DIR = process.env.CVH_DATA_DIR || join(homedir(), '.claude-voice-harness');
export const CRASH_LOG_PATH = join(DATA_DIR, 'crash.log');

const MAX_BYTES = 1024 * 1024; // rotate to crash.log.1 past this

export function crashLog(kind, detail = '') {
  try {
    try {
      if (statSync(CRASH_LOG_PATH).size > MAX_BYTES) {
        renameSync(CRASH_LOG_PATH, CRASH_LOG_PATH + '.1');
      }
    } catch { /* no file yet, or rotation raced — either is fine */ }
    const text = String(detail).replace(/\s+/g, ' ').trim();
    appendFileSync(CRASH_LOG_PATH, `[${new Date().toISOString()}] pid=${process.pid} ${kind}${text ? ` ${text}` : ''}\n`);
  } catch {
    // Crash logging must never create a second crash.
  }
}
