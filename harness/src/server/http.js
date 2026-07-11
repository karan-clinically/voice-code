// Express app: health + sessions now; more routers mounted in later steps.
// Auth is applied to all /api/* routes (localhost bypass OR bearer token).

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authMiddleware } from './auth.js';
import { makeLogger } from '../util/logger.js';
import sessionsRouter from './routes/sessions.js';

const log = makeLogger('http');
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Auth gate for the whole API surface.
  app.use('/api', authMiddleware);

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: pkg.version });
  });

  app.use('/api/sessions', sessionsRouter);

  // JSON 404 + error handler so nothing leaks HTML/stack traces.
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`unhandled route error: ${err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
