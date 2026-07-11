// WebSocket server at /ws — pushes live events to desktop/phone clients.
// Auth mirrors the HTTP side: localhost is allowed; remote clients must pass
// ?token=<pairing_token>. Server -> client messages:
//   {type:'sessions', sessions:[...]}         on any session-list change
//   {type:'state', sessionId, state}           idle|busy|response_ready|dead
//   {type:'response', sessionId, interactionId, summary, audioUrl}
//   {type:'log', level, message}               for the desktop LiveLog

import { WebSocketServer } from 'ws';
import { getConfig } from '../config.js';
import { isLocalhost } from './auth.js';
import { sessionEvents, listSessions } from '../services/sessionManager.js';
import { logEvents } from '../util/logger.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('ws');
let wss = null;

export function attachWs(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!authorizeWs(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    send(ws, { type: 'sessions', sessions: listSessions() }); // initial snapshot
  });

  sessionEvents.on('change', () => broadcast({ type: 'sessions', sessions: listSessions() }));
  sessionEvents.on('state', ({ id, state }) => broadcast({ type: 'state', sessionId: id, state }));
  logEvents.on('log', (l) => {
    if (l.level === 'debug') return; // keep the LiveLog readable
    broadcast({ type: 'log', level: l.level, message: l.message });
  });

  log.info('websocket server attached at /ws');
}

function authorizeWs(req) {
  if (isLocalhost(req)) return true;
  const token = getConfig('pairing_token');
  let q = null;
  try {
    q = new URL(req.url, 'http://localhost').searchParams.get('token');
  } catch {
    q = null;
  }
  return !!(token && q && q === token);
}

export function broadcastResponse({ sessionId, interactionId, summary, audioUrl }) {
  broadcast({ type: 'response', sessionId, interactionId, summary, audioUrl });
}

function broadcast(obj) {
  if (!wss) return;
  const s = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(s);
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
