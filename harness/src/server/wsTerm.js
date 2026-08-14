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
import { isLocalhost } from './auth.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('wsTerm');

// Scrollback replayed to a client that reached us through a proxy — the phone on
// the funnel, or the /desktop xterm through cloudflared. A direct-loopback client
// still gets the whole buffer, because there it is a memcpy. Off the machine it
// is not: the buffer holds up to 1.5MB of raw ANSI, which JSON-escapes to 2-3MB
// on the wire (every ESC becomes six characters), and a client pays it again on
// EVERY reconnect. Capping here rather than trusting `?replay=0` means a client
// that predates that opt-out — a phone still running a cached PWA bundle — gets
// a fast connect too, instead of a multi-megabyte download it discards.
const REMOTE_REPLAY_BYTES = Math.max(16 * 1024, Number(process.env.CVH_TERM_REMOTE_REPLAY_BYTES) || 128 * 1024);
// Burst window for the change signal sent to a payload-less client. Leading edge,
// so the first byte after a quiet moment still goes out immediately and keypad
// echo stays instant; only a continuing burst is collapsed. Matched to the phone's
// own 300ms repaint throttle — signalling faster than it can paint buys nothing.
const SIGNAL_COALESCE_MS = 250;

// The replay payload for one connection: everything, a tail, or nothing.
export function replayForConnection(buffer, { wantsReplay, local }) {
  if (!wantsReplay || !buffer) return '';
  if (local || buffer.length <= REMOTE_REPLAY_BYTES) return buffer;
  const tail = buffer.slice(-REMOTE_REPLAY_BYTES);
  // Resume at a line boundary so the tail can't open mid-escape-sequence and
  // paint the leftover bytes of a truncated code as literal text.
  const nl = tail.indexOf('\n');
  return nl === -1 ? tail : tail.slice(nl + 1);
}

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
    // `?replay=0` opts out, and the phone does: it renders from the HTTP screen
    // endpoint and uses this socket purely as a "something changed, repaint now"
    // trigger plus a key channel — it discards the payload. The buffer runs to
    // 1.5MB, so sending it anyway cost a mobile connection several seconds of
    // transfer it never read, on EVERY reconnect (resume, network handoff,
    // heartbeat miss). Worse, the pong for the liveness probe queued behind it and
    // blew its own deadline, so the client closed the socket and started the whole
    // download again — a loop that never converged on a slow link.
    const wantsReplay = new URL(req.url, 'http://localhost').searchParams.get('replay') !== '0';
    const replay = replayForConnection(getReplayBuffer(ptyId), {
      wantsReplay,
      local: isLocalhost(req),
    });
    if (replay) send(ws, { t: 'data', d: replay });

    // A client that opted out of the replay does not read the live stream either —
    // it repaints from /screen and only needs to know that something changed. (The
    // phone opens two of these sockets per session: the terminal's repaint trigger
    // and the keypad's raw-key channel, and the second one reads nothing but pongs.)
    // Send those an empty change signal, coalesced, instead of the bytes: a burst
    // of TUI redraws then costs a phone a few bytes rather than a continuous ANSI
    // download it throws away — which is what used to queue ahead of the pong and
    // trip the client's own zombie-socket detector into a reconnect.
    let signalTimer = null;
    let signalPending = false;
    const signalChange = () => {
      if (signalTimer) {
        signalPending = true;
        return;
      }
      send(ws, { t: 'data', d: '' });
      signalTimer = setTimeout(() => {
        signalTimer = null;
        if (signalPending) {
          signalPending = false;
          signalChange();
        }
      }, SIGNAL_COALESCE_MS);
    };
    const onData = ({ id, data }) => {
      if (id !== ptyId) return;
      if (wantsReplay) send(ws, { t: 'data', d: data });
      else signalChange();
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
      clearTimeout(signalTimer);
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
