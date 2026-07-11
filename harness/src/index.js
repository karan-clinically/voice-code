// Harness entry point: start the HTTP (and later WS) server, the session
// reconciler, and wire graceful shutdown that kills all owned PTYs.

import './db.js'; // side effect: open DB + run migrations
import { getConfig } from './config.js';
import { buildApp } from './server/http.js';
import { startReconciler, stopReconciler } from './services/sessionManager.js';
import * as terminal from './services/terminal.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('index');
const PORT = Number(getConfig('port', 4620));

const app = buildApp();
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`harness listening on http://0.0.0.0:${PORT}`);
});
server.on('error', (err) => {
  log.error(`server error: ${err.message}`);
  process.exit(1);
});

startReconciler();

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
