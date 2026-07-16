// WebSocket server at /ws — pushes live events to desktop/phone clients.
// Auth mirrors the HTTP side: localhost is allowed; remote clients must pass
// ?token=<pairing_token>. Server -> client messages:
//   {type:'sessions', sessions:[...]}         on any session-list change
//   {type:'state', sessionId, state}           idle|busy|response_ready|dead
//   {type:'response', sessionId, interactionId, summary, audioUrl}
//   {type:'log', level, message}               for the desktop LiveLog

import { WebSocketServer } from 'ws';
import { isLocalhost, isTailnetPeer, hasValidToken } from './auth.js';
import { sessionEvents, listSessions } from '../services/sessionManager.js';
import { events as claudeEvents } from '../services/claudeCode.js';
import { createTermWss } from './wsTerm.js';
import { createSttWss } from './wsStt.js';
import { logEvents } from '../util/logger.js';
import { makeLogger } from '../util/logger.js';
import { attachHeartbeat } from '../util/wsHeartbeat.js';

const log = makeLogger('ws');
let wss = null;
let wssTerm = null;
let wssStt = null;

export function attachWs(server) {
  wss = new WebSocketServer({ noServer: true });
  wssTerm = createTermWss(); // raw terminal transport (/ws/term)
  wssStt = createSttWss(); // live speech-to-text relay (/ws/stt)
  // Detect and drop connections a phone silently walked away from (network
  // handoff, screen lock killing the radio) on all three sockets.
  attachHeartbeat(wss);
  attachHeartbeat(wssTerm);
  attachHeartbeat(wssStt);

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    const target =
      pathname === '/ws' ? wss : pathname === '/ws/term' ? wssTerm : pathname === '/ws/stt' ? wssStt : null;
    if (!target) {
      socket.destroy();
      return;
    }
    if (!authorizeWs(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    send(ws, { type: 'sessions', sessions: listSessions() }); // initial snapshot
  });

  sessionEvents.on('change', () => broadcast({ type: 'sessions', sessions: listSessions() }));
  sessionEvents.on('state', ({ id, state }) => broadcast({ type: 'state', sessionId: id, state }));
  // A completed Claude turn (any input path, incl. typing straight into the
  // terminal). Carries a spoken-length summary so the desktop can read it back
  // when "Speak replies" is on. See claudeCode.signalStop().
  claudeEvents.on('turn', ({ sessionId, text }) => broadcast({ type: 'turn', sessionId, text }));
  logEvents.on('log', (l) => {
    if (l.level === 'debug') return; // keep the LiveLog readable
    broadcast({ type: 'log', level: l.level, message: l.message });
  });

  log.info('websocket server attached at /ws');
}

// Same trust tiers as the HTTP side (auth.js): true localhost, a tailnet peer
// proxied by tailscaled, or the pairing token (?token= — funnel clients).
function authorizeWs(req) {
  return isLocalhost(req) || isTailnetPeer(req) || hasValidToken(req);
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
