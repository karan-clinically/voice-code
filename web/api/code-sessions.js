// GET /api/code-sessions — read-only list of the user's claude.ai/code cloud
// sessions, shown alongside the Managed Agents sessions this app can drive.
//
// There is no public API for *sending* messages into claude.ai/code sessions,
// so these rows are display + deep-link only. The list comes from the same
// endpoint the harness used (harness/src/services/codeSessions.js): a plain
// authorised GET with the Claude Code OAuth access token. On the PC the CLI
// refreshed that token in place; here it's a static CLAUDE_CODE_OAUTH_TOKEN
// env var, so when it lapses this list quietly reports configured-but-stale
// (401) rather than erroring the whole app. Optional — leave the var unset to
// hide the section.

import { requireAuth, json, fail } from './_lib/util.js';

const ENDPOINT = 'https://api.anthropic.com/v1/code/sessions?limit=50';

function slugFromUrl(u) {
  const m = String(u || '').match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    json(res, 200, { configured: false, sessions: [] });
    return;
  }
  try {
    const r = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!r.ok) {
      json(res, 200, { configured: true, stale: true, status: r.status, sessions: [] });
      return;
    }
    const j = await r.json();
    const sessions = (j.data || []).map((s) => {
      const src = (s.config?.sources || []).find((x) => x.type === 'git_repository');
      return {
        id: s.id,
        title: s.title || null,
        bucket: s.status_bucket || null,
        working: s.status_bucket === 'working',
        unread: !!s.unread,
        envKind: s.environment_kind || null,
        repo: src ? slugFromUrl(src.url) : null,
        ts: s.last_event_at || s.created_at || null,
        url: `https://claude.ai/code/${String(s.id || '').replace(/^cse_/, 'session_')}`,
      };
    });
    json(res, 200, { configured: true, sessions });
  } catch (err) {
    fail(res, err);
  }
}
