// Local registry of running Claude Code processes, via `claude agents --json`.
//
// This is the ONLY source that distinguishes a background agent from an ordinary
// resumable session. Background agents (kind 'background') run detached in Claude's
// supervisor and reject `claude --resume <uuid>` ("currently running as a background
// agent") — they can only be reached through the agent view. The phone needs to know
// which sessions are background agents so a tap routes to the agent view instead of a
// doomed resume.
//
// `claude agents --json` needs no TTY and exits, but each call spawns claude (~1.5s),
// so read it cached + non-blocking exactly like codeSessions: refresh in the
// background and hand back the last good list immediately.

import { execFile } from 'node:child_process';
import { resolveClaudeCommand } from './terminal.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('agent-registry');

let cache = { at: 0, data: [] };
let inflight = null;

function fetchAgents() {
  return new Promise((resolve) => {
    execFile(
      resolveClaudeCommand(),
      ['agents', '--json'],
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.warn(`claude agents --json failed: ${err.message}`);
          resolve(cache.data); // keep the last good list on a transient failure
          return;
        }
        try {
          const j = JSON.parse(stdout);
          const arr = Array.isArray(j) ? j : j.sessions || j.data || [];
          resolve(
            arr.map((s) => ({
              id: s.id || null,
              sessionId: s.sessionId || null, // transcript uuid
              kind: s.kind || null, // 'interactive' | 'background'
              name: s.name || null, // live title
              state: s.state || null, // 'working' | 'blocked' | 'done' | …
              status: s.status || null, // 'busy' | 'idle'
              cwd: s.cwd || null,
              pid: s.pid || null,
            }))
          );
        } catch (e) {
          log.warn(`parse failed: ${e.message}`);
          resolve(cache.data);
        }
      }
    );
  });
}

export function agentRegistry({ maxAgeMs = 8000 } = {}) {
  if (Date.now() - cache.at > maxAgeMs && !inflight) {
    inflight = fetchAgents()
      .then((d) => {
        cache = { at: Date.now(), data: d };
      })
      .catch((e) => log.warn(`refresh failed: ${e.message}`))
      .finally(() => {
        inflight = null;
      });
  }
  return cache.data;
}

// transcript uuid -> agent record, background agents only (the ones --resume rejects).
export function backgroundAgents() {
  const m = new Map();
  for (const a of agentRegistry()) {
    if (a.kind === 'background' && a.sessionId) m.set(a.sessionId, a);
  }
  return m;
}

// Warm the cache at boot so the first /recent poll already knows the agents.
agentRegistry();
