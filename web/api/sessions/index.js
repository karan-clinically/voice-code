// GET  /api/sessions            — list Managed Agents sessions (newest first)
// POST /api/sessions {title, message?} — create a session, optionally sending
//                                  the first user message in the same call.

import { requireAuth, json, fail, anthropic } from '../_lib/util.js';
import { resolveAgentAndEnv } from '../_lib/agent.js';

function lite(s) {
  return {
    id: s.id,
    title: s.title || null,
    status: s.status,
    created_at: s.created_at || null,
    updated_at: s.updated_at || null,
  };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const page = await anthropic('/v1/sessions', {
        query: { limit: req.query.limit || 30, page: req.query.page },
      });
      json(res, 200, {
        sessions: (page.data || []).map(lite),
        next_page: page.next_page ?? null,
      });
      return;
    }

    if (req.method === 'POST') {
      const { title, message } = req.body || {};
      const { agentId, environmentId } = await resolveAgentAndEnv();
      const session = await anthropic('/v1/sessions', {
        method: 'POST',
        body: {
          agent: agentId,
          environment_id: environmentId,
          title: title || (message ? message.slice(0, 60) : 'Voice session'),
        },
      });
      if (message && message.trim()) {
        await anthropic(`/v1/sessions/${session.id}/events`, {
          method: 'POST',
          body: {
            events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
          },
        });
      }
      json(res, 201, lite(session));
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    fail(res, err);
  }
}
