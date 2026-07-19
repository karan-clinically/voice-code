// GET    /api/sessions/:id — session detail (status drives the client's polling)
// DELETE /api/sessions/:id — permanently delete the session and its sandbox

import { requireAuth, json, fail, anthropic } from '../../_lib/util.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const { id } = req.query;
  try {
    if (req.method === 'GET') {
      const s = await anthropic(`/v1/sessions/${id}`);
      json(res, 200, {
        id: s.id,
        title: s.title || null,
        status: s.status,
        created_at: s.created_at || null,
        updated_at: s.updated_at || null,
      });
      return;
    }
    if (req.method === 'DELETE') {
      await anthropic(`/v1/sessions/${id}`, { method: 'DELETE' });
      json(res, 200, { ok: true });
      return;
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    fail(res, err);
  }
}
