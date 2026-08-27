#!/usr/bin/env node
// User-scoped Codex hook bridge. Codex sends one lifecycle event as JSON on
// stdin; only harness-owned sessions carry CVH_SESSION_ID, so all other Codex
// launches are a no-op even though they discover the same global hooks.json.

import { codexHookToAgentEvent } from '../src/services/codexHooks.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const event = codexHookToAgentEvent(input);
  if (event) {
    // Completion also uses the legacy Stop endpoint so an already-running harness
    // gains exact Codex completion badges before its next restart. Other lifecycle
    // states only exist on the canonical provider-neutral endpoint.
    const completed = event.type === 'turn.completed';
    await fetch(completed
      ? 'http://127.0.0.1:4620/api/hooks/stop'
      : 'http://127.0.0.1:4620/api/agent-events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(completed ? { 'x-cvh-session': event.correlationId } : {}),
      },
      body: JSON.stringify(completed ? {
        session_id: event.externalSessionId,
        cwd: event.cwd,
        last_assistant_message: event.responseText,
        transcript_path: event.transcriptPath,
      } : event),
      signal: AbortSignal.timeout(4000),
    });
  }
} catch {
  // Hooks must never make Codex unusable when the harness is restarting/offline.
  // The existing terminal stabilization path remains the fallback.
}

// Stop hooks require JSON on stdout when they exit successfully. `{}` is also a
// harmless valid result for every other event we install.
process.stdout.write('{}\n');
