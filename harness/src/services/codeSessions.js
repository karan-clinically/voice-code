// The Claude Code app's own session list.
//
// The app's "Code" list is server-side state — it is NOT derivable from anything
// on disk (the local transcript archive and ~/.claude/sessions/*.json are a
// different, only-partly-overlapping set, and the app's names live only on the
// server). It comes from:
//
//   GET https://api.anthropic.com/v1/code/sessions
//
// authorised with the OAuth token Claude Code stores in ~/.claude/.credentials.json
// (scope `user:sessions:claude_code`). We re-read that file on every call because
// the running CLI refreshes the token in place. Note claude.ai serves the same
// route but sits behind a bot-check; the api.anthropic.com host does not, so this
// is a plain authorised API call.
//
// Each record carries exactly what the app renders: title, connection_status
// (connected|disconnected), status_bucket (working|completed|review_ready|blocked),
// unread, environment_kind (bridge = remote-controlled terminal | anthropic_cloud)
// and a git source whose url gives the owner/repo line.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('code-sessions');
const CREDS = join(homedir(), '.claude', '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/v1/code/sessions?limit=50';

let cache = { at: 0, data: [] };
let inflight = null;

function readToken() {
  try {
    return JSON.parse(readFileSync(CREDS, 'utf8'))?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function slugFromUrl(u) {
  const m = String(u || '').match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function fetchList() {
  const token = readToken();
  if (!token) {
    log.warn('no claude.ai OAuth token in ~/.claude/.credentials.json');
    return [];
  }
  const r = await fetch(ENDPOINT, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  });
  if (!r.ok) {
    // 401 => the stored token lapsed; the running CLI rewrites it, so the next
    // poll picks the fresh one up on its own.
    log.warn(`GET /v1/code/sessions -> ${r.status}`);
    return cache.data;
  }
  const j = await r.json();
  return (j.data || []).map((s) => {
    const src = (s.config?.sources || []).find((x) => x.type === 'git_repository');
    return {
      id: s.id, // cse_<suffix>; the local bridgeSessionId is session_<same suffix>
      suffix: String(s.id || '').replace(/^cse_/, ''),
      title: s.title || null,
      connected: s.connection_status === 'connected',
      working: s.status_bucket === 'working',
      bucket: s.status_bucket || null,
      unread: !!s.unread,
      envKind: s.environment_kind || null, // bridge | anthropic_cloud
      repo: src ? slugFromUrl(src.url) : null,
      branch: src?.revision || null,
      ts: s.last_event_at || s.created_at || null,
    };
  });
}

// Cached read. The phone polls every 5s, so refresh in the background and hand
// back the last good list immediately — the endpoint never blocks on the network.
export function codeSessions({ maxAgeMs = 8000 } = {}) {
  if (Date.now() - cache.at > maxAgeMs && !inflight) {
    inflight = fetchList()
      .then((d) => {
        cache = { at: Date.now(), data: d };
      })
      .catch((e) => log.warn(`fetch failed: ${e.message}`))
      .finally(() => {
        inflight = null;
      });
  }
  return cache.data;
}

// Warm the cache at boot so the first poll already has the list.
codeSessions();
