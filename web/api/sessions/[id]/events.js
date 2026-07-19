// GET  /api/sessions/:id/events — the session's event history, mapped to the
//        light transcript shape the client renders. The client polls this while
//        the session is running (2.5s cadence) — far more robust on a phone
//        than holding an SSE stream open through a serverless function, and the
//        Managed Agents history endpoint is the documented catch-up mechanism.
// POST /api/sessions/:id/events {text} — send a user message (starts/continues
//        a turn); {interrupt: true} — stop the agent mid-run.

import { requireAuth, json, fail, anthropic } from '../../_lib/util.js';

// Only what the transcript renders. Tool results, spans, and thinking are
// dropped server-side to keep poll payloads small on mobile data.
const RENDERED = new Set([
  'user.message',
  'agent.message',
  'agent.tool_use',
  'agent.mcp_tool_use',
  'session.status_idle',
  'session.status_running',
  'session.error',
]);

function textOf(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function mapEvent(e) {
  const base = { id: e.id, type: e.type, at: e.processed_at || null };
  switch (e.type) {
    case 'user.message':
    case 'agent.message':
      return { ...base, text: textOf(e.content) };
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
      return { ...base, tool: e.name || null };
    case 'session.status_idle':
      return { ...base, stop_reason: e.stop_reason?.type || e.stop_reason || null };
    case 'session.error':
      return { ...base, error: e.error?.message || 'session error' };
    default:
      return base;
  }
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const { id } = req.query;
  try {
    if (req.method === 'GET') {
      const page = await anthropic(`/v1/sessions/${id}/events`, {
        query: { page: req.query.page },
      });
      const events = (page.data || []).filter((e) => RENDERED.has(e.type)).map(mapEvent);
      // Transcript wants chronological order; normalize in case the API lists newest-first.
      const first = events.find((e) => e.at);
      const last = [...events].reverse().find((e) => e.at);
      if (first && last && first.at > last.at) events.reverse();
      json(res, 200, { events, next_page: page.next_page ?? null });
      return;
    }

    if (req.method === 'POST') {
      const { text, interrupt } = req.body || {};
      let event;
      if (interrupt) {
        event = { type: 'user.interrupt' };
      } else if (text && text.trim()) {
        event = { type: 'user.message', content: [{ type: 'text', text }] };
      } else {
        json(res, 400, { error: 'text or interrupt required' });
        return;
      }
      await anthropic(`/v1/sessions/${id}/events`, { method: 'POST', body: { events: [event] } });
      json(res, 200, { ok: true });
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    fail(res, err);
  }
}
