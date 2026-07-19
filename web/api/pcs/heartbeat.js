// POST /api/pcs/heartbeat — called by each PC's harness every ~30s (see
// harness/src/services/hubPresence.js). Auth is the same APP_ACCESS_TOKEN the
// phone uses; the harness supplies it as HUB_TOKEN. The registry keeps every
// PC ever seen — "online" is derived from last_seen recency at read time, so a
// PC that stops beating simply shows as disconnected (AnyDesk-style), it
// doesn't vanish.

import { requireAuth, json, fail } from '../_lib/util.js';
import { kv, kvConfigured } from '../_lib/kv.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }
  if (!kvConfigured()) {
    json(res, 503, { error: 'KV store not configured on the hub' });
    return;
  }
  try {
    const { id, name, baseUrl, token } = req.body || {};
    if (!id) {
      json(res, 400, { error: 'id required' });
      return;
    }
    const entry = {
      id: String(id),
      name: String(name || id),
      baseUrl: baseUrl ? String(baseUrl) : null,
      token: token ? String(token) : null,
      last_seen: Date.now(),
    };
    await kv('HSET', 'pcs', entry.id, JSON.stringify(entry));
    json(res, 200, { ok: true });
  } catch (err) {
    fail(res, err);
  }
}
