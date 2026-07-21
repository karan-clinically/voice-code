// Express app: health + sessions now; more routers mounted in later steps.
// Auth is applied to all /api/* routes (localhost bypass OR bearer token).

import express from 'express';
import compression from 'compression';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authMiddleware } from './auth.js';
import { makeLogger } from '../util/logger.js';
import sessionsRouter from './routes/sessions.js';
import transcribeRouter from './routes/transcribe.js';
import settingsRouter from './routes/settings.js';
import commandRouter from './routes/command.js';
import hooksRouter from './routes/hooks.js';
import ttsRouter from './routes/tts.js';
import configRouter from './routes/config.js';
import voicesRouter from './routes/voices.js';
import tunnelRouter from './routes/tunnel.js';
import pairingRouter from './routes/pairing.js';
import fsRouter from './routes/fs.js';
import archiveRouter from './routes/archive.js';
import promptsRouter from './routes/prompts.js';
import usageRouter from './routes/usage.js';
import pushRouter from './routes/push.js';
import providersRouter from './routes/providers.js';
import agentEventsRouter from './routes/agentEvents.js';

const log = makeLogger('http');
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  // Terminal snapshots and parsed transcripts are highly repetitive text. Gzip
  // cuts the largest mobile responses by an order of magnitude over Tailscale.
  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: '2mb' }));

  // Scoped CORS: reflect only localhost origins and file:// ('null'). This lets
  // the Electron renderer (dev http://localhost:5173, prod file://) call the API
  // without opening it to arbitrary websites — important because localhost
  // requests bypass bearer auth.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Auth gate for the whole API surface.
  app.use('/api', authMiddleware);

  // Hash of the JS bundle we're currently serving. An installed PWA keeps its loaded
  // page in memory across backgrounding and the app-shell cache can be stale, so a
  // rebuilt frontend can otherwise sit unseen on the phone for hours. The client
  // compares this against the bundle IT loaded and reloads on a mismatch. Cached on
  // index.html's mtime so /health stays a cheap call.
  const distIndex = join(__dirname, '../../../mobile-web/dist/index.html');
  let buildCache = { mtime: 0, id: null };
  function buildId() {
    try {
      const mtime = statSync(distIndex).mtimeMs;
      if (mtime !== buildCache.mtime) {
        const m = readFileSync(distIndex, 'utf8').match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
        buildCache = { mtime, id: m ? m[1] : null };
      }
      return buildCache.id;
    } catch {
      return null; // not built yet — the client just skips the check
    }
  }

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); // never let a proxy pin the build id
    res.json({ ok: true, version: pkg.version, build: buildId() });
  });

  // Mobile web client (served shell; its API calls are gated normally). Reached
  // from the phone browser over Tailscale — ideally via `tailscale serve` HTTPS
  // so the microphone works.
  // React (Vite) build lives at mobile-web/dist; base is /m/, so assets are at
  // /m/assets/*. The hand-written app is kept at ../mobile/index.legacy.html.
  const mobileDist = join(__dirname, '../../../mobile-web/dist');
  // Serve the whole build under /m so the PWA's service worker, manifest and icon
  // (dist-root files, not under /assets) are reachable. index:false so a bare /m
  // still falls through to the SPA shell below.
  app.use('/m', express.static(mobileDist, { index: false }));
  app.get(['/m', '/m/', '/mobile'], (req, res) => res.sendFile(join(mobileDist, 'index.html')));

  app.use('/api/sessions', sessionsRouter);
  app.use('/api/transcribe', transcribeRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/command', commandRouter);
  app.use('/api/hooks', hooksRouter);
  app.use('/api/tts', ttsRouter);
  app.use('/api/config', configRouter);
  app.use('/api/voices', voicesRouter);
  app.use('/api/tunnel', tunnelRouter);
  app.use('/api/pairing', pairingRouter);
  app.use('/api/fs', fsRouter);
  app.use('/api/archive', archiveRouter);
  app.use('/api/prompts', promptsRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/providers', providersRouter);
  app.use('/api/agent-events', agentEventsRouter);

  // JSON 404 + error handler so nothing leaks HTML/stack traces.
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`unhandled route error: ${err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
