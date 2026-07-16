// Standard `ws` broken-connection detector (recommended by the ws docs): a phone
// that loses its network mid-session doesn't send a close frame, so the socket
// looks OPEN on both ends forever and the client's own reconnect-on-close logic
// never fires. Ping every client on an interval; any client that didn't pong
// since the last ping gets terminated, which finally gives the browser a real
// close event to reconnect on.
export function attachHeartbeat(wss, intervalMs = 25000) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* already gone */
      }
    }
  }, intervalMs);
  wss.on('close', () => clearInterval(timer));
  return timer;
}
