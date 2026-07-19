// GET    /api/pcs        — the device list: every PC that has ever heartbeated,
//                          with online derived from last_seen (< 75s = two
//                          missed beats). Online first, then most recent.
// DELETE /api/pcs?id=…   — forget a retired PC.

import { requireAuth, json, fail } from '../_lib/util.js';
import { kv, kvConfigured, hgetallObject } from '../_lib/kv.js';

const ONLINE_WINDOW_MS = 75_000;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      if (!kvConfigured()) {
        json(res, 200, { configured: false, pcs: [] });
        return;
      }
      const raw = await hgetallObject('pcs');
      const now = Date.now();
      const pcs = Object.values(raw)
        .map((v) => {
          try {
            return JSON.parse(v);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map((p) => ({ ...p, online: now - (p.last_seen || 0) < ONLINE_WINDOW_MS }))
        .sort((a, b) => Number(b.online) - Number(a.online) || (b.last_seen || 0) - (a.last_seen || 0));
      json(res, 200, { configured: true, pcs });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        json(res, 400, { error: 'id required' });
        return;
      }
      await kv('HDEL', 'pcs', String(id));
      json(res, 200, { ok: true });
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    fail(res, err);
  }
}
