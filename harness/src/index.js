// Harness entry point: start the HTTP (and later WS) server, the session
// reconciler, and wire graceful shutdown that kills all owned PTYs.

// Load harness/.env (if present) for headless/curl testing before the desktop
// wizard has written keys to SQLite. Native to Node 20.6+ — no dependency.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '../.env'));
} catch {
  // no .env file — fine, config comes from SQLite (the wizard)
}

import './db.js'; // side effect: open DB + run migrations
import { getConfig } from './config.js';
import { buildApp } from './server/http.js';
import { attachWs } from './server/ws.js';
import { ensureServe } from './services/tunnel.js';
import { startReconciler, stopReconciler } from './services/sessionManager.js';
import { startNotifier } from './services/notify.js';
import { startIndexer } from './services/archiveIndex.js';
import * as terminal from './services/terminal.js';
import { makeLogger } from './util/logger.js';
import { startWatchdog } from './util/watchdog.js';

const log = makeLogger('index');
const PORT = Number(getConfig('port', 4620));

// Last-resort crash forensics. The supervisor (harness-run.cmd) respawns us after
// any exit, which HIDES crashes: an uncaught throw printed only to the detached
// console and the harness appeared to "randomly restart" with nothing in the logs
// (every restart also kills all owned PTYs — i.e. every live session). Log the real
// reason to SQLite before dying so the next investigation starts from evidence.
// Exit on uncaughtException (state is suspect; the supervisor restarts us) but only
// log unhandledRejection — those are typically stray async errors (a WS write racing
// a disconnect), not corruption, and killing every live session over one is worse.
process.on('uncaughtException', (err) => {
  try { log.error(`FATAL uncaughtException: ${err?.stack || err}`); } catch { /* logging must not mask the exit */ }
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 250).unref(); // let the SQLite write flush
});
process.on('unhandledRejection', (reason) => {
  try { log.error(`unhandledRejection: ${reason?.stack || reason}`); } catch { /* ignore */ }
});

const app = buildApp();
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`harness listening on http://0.0.0.0:${PORT}`);
});
attachWs(server);
server.on('error', (err) => {
  log.error(`server error: ${err.message}`);
  process.exit(1);
});

startReconciler();
startNotifier(); // session-attention → phone push notifications
startWatchdog(); // a wedged event loop becomes a logged exit-99 + 3s respawn, not a 30-min dead phone

// Build/refresh the session archive (scan ~/.claude/projects/*.jsonl). Runs
// shortly after boot and periodically; incremental by file mtime so rescans are
// cheap. Non-blocking — search just returns fewer results until the first pass
// completes.
startIndexer();

// Self-heal the Tailscale serve/funnel mapping (something on this machine keeps
// repointing the root path). Only keeps the loop if the first re-pin succeeds
// (i.e. Tailscale is present). Disable with tailscale_serve=off. tunnel_mode
// 'funnel' publishes to the PUBLIC internet — auth.js gates that traffic behind
// the pairing token, unlike tailnet serve traffic which stays tokenless.
if (getConfig('tailscale_serve', 'on') !== 'off') {
  const mode = getConfig('tunnel_mode', 'serve');
  ensureServe(PORT, mode).then((ok) => {
    if (!ok) return;
    log.info(`tailscale ${mode} self-heal enabled (re-pin every 60s)`);
    const timer = setInterval(() => ensureServe(PORT, mode).catch(() => {}), 60_000);
    timer.unref?.();
  });
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal})`);
  stopReconciler();
  terminal.killAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, app };
