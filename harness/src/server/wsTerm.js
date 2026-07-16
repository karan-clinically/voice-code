// Raw terminal WebSocket at /ws/term?session=<dbId>. Gives the desktop xterm.js
// client a real, bidirectional connection to a session's PTY:
//   server -> client  {t:'data', d}   raw PTY output (a replay chunk on connect,
//                                       then live output)
//                     {t:'exit'}       the PTY exited
//                     {t:'pong'}       reply to a client {t:'ping'}
//   client -> server  {t:'in', d}      raw keystrokes written straight to the PTY
//                     {t:'resize', cols, rows}
//                     {t:'ping'}       app-level liveness probe. Browsers can't send
//                                      protocol pings, and a socket that died without
//                                      a FIN (network handoff, host gone) stays OPEN
//                                      client-side forever — the pong is how the phone
//                                      detects that and forces a reconnect.
//
// Auth mirrors /ws (localhost allowed; remote needs ?token=), applied in ws.js.
// Raw input intentionally bypasses the C0-strip in sessionManager.sendInput —
// a terminal needs arrows, Ctrl-C, Escape etc. to pass through. That is safe
// here because the connection is gated to the machine owner (localhost/token);
// the phone keeps using the sanitised line-based /api/sessions/:id/input.

import { WebSocketServer } from 'ws';
import { terminalEvents, getReplayBuffer, sendRaw, resize } from '../services/terminal.js';
import { getPtyId } from '../services/sessionManager.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('wsTerm');

export function createTermWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    let dbId = null;
    try {
      dbId = new URL(req.url, 'http://localhost').searchParams.get('session');
    } catch {
      dbId = null;
    }
    const ptyId = dbId != null ? getPtyId(dbId) : null;
    if (!ptyId) {
      try {
        ws.send(JSON.stringify({ t: 'exit', reason: 'no live session' }));
      } catch {
        /* ignore */
      }
      ws.close();
      return;
    }

    // Replay existing screen + scrollback so the terminal paints immediately.
    const replay = getReplayBuffer(ptyId);
    if (replay) send(ws, { t: 'data', d: replay });

    const onData = ({ id, data }) => {
      if (id === ptyId) send(ws, { t: 'data', d: data });
    };
    const onExit = ({ id }) => {
      if (id === ptyId) send(ws, { t: 'exit' });
    };
    terminalEvents.on('data', onData);
    terminalEvents.on('exit', onExit);

    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.t === 'ping') {
        send(ws, { t: 'pong' });
      } else if (m.t === 'in' && typeof m.d === 'string') {
        try {
          sendRaw(ptyId, m.d);
        } catch (err) {
          log.debug(`input to ${ptyId} failed: ${err.message}`);
        }
      } else if (m.t === 'resize') {
        resize(ptyId, Number(m.cols) || 80, Number(m.rows) || 24);
      }
    });

    ws.on('close', () => {
      terminalEvents.off('data', onData);
      terminalEvents.off('exit', onExit);
    });

    log.debug(`term client attached to db#${dbId} (pty ${ptyId})`);
  });

  return wss;
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* client went away */
    }
  }
}
