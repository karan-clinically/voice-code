// Event-loop watchdog. The harness has wedged in production — no logs, no exit,
// reindex heartbeat silent for 30 minutes while the supervisor (which only restarts
// after an EXIT) waited on a process that never died. A blocked main thread can't
// observe itself, so the sentinel lives on a worker thread: the main loop posts a
// heartbeat every few seconds; if none arrives for `staleMs`, the worker logs the
// wedge and SIGKILLs the whole process from the OS side (needs no cooperation from
// the stuck main loop). The supervisor stamps the exit code and respawns within
// seconds; the "[watchdog]" line in harness.out.log marks it as a watchdog kill.
//
// A wedged harness is strictly worse than a killed one: every PTY is unusable either
// way, but the wedge also blocks the supervisor from ever recovering.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const BEAT_MS = 5_000;
const STALE_MS = 90_000; // ~18 missed beats — nothing legitimate blocks that long

// ---- sentinel (this same file, loaded as the worker) ----
if (!isMainThread && workerData?.role === 'cvh-watchdog') {
  let last = Date.now();
  parentPort.on('message', () => { last = Date.now(); });
  setInterval(() => {
    const stale = Date.now() - last;
    if (stale > workerData.staleMs) {
      // console goes to harness.out.log via the supervisor redirect; the SQLite
      // logger lives on the (blocked) main thread and can't be used from here.
      console.error(`[watchdog] main event loop unresponsive for ${Math.round(stale / 1000)}s — killing process for supervisor restart`);
      // NOT process.exit(): inside a worker that stops only THIS thread — the wedged
      // main thread would keep the process alive, which is the exact failure we're
      // here to end. SIGKILL goes through the OS (TerminateProcess) and needs no
      // cooperation from the blocked main loop. The beat of delay lets the log line
      // flush; this worker's own loop is healthy, so the timeout does fire.
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 250);
    }
  }, 15_000).unref();
}

export function startWatchdog({ staleMs = STALE_MS } = {}) {
  if (!isMainThread) return null;
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'cvh-watchdog', staleMs } });
  worker.unref(); // never keep the process alive on our account
  const beat = setInterval(() => worker.postMessage(0), BEAT_MS);
  beat.unref();
  worker.on('error', () => clearInterval(beat)); // watchdog death must not hurt the harness
  return worker;
}
