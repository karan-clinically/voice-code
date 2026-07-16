// Canonical provider-neutral events emitted by adapters, wrappers, or native
// CLI hooks. Legacy Claude/Grok Stop hooks are translated onto this same turn
// lifecycle while old endpoints remain available.

import * as sessions from './sessionManager.js';
import { signalStop } from './claudeCode.js';

export const AGENT_EVENT_TYPES = new Set([
  'agent.started',
  'auth.required',
  'turn.started',
  'prompt.requested',
  'turn.completed',
  'turn.failed',
  'usage.reported',
  'agent.exited',
]);

export function acceptAgentEvent(event = {}) {
  if (!AGENT_EVENT_TYPES.has(event.type)) throw new Error(`unknown agent event: ${event.type || '(missing)'}`);
  const correlationId = event.correlationId || event.sessionToken || event.CVH_SESSION_ID || null;
  const dbId = correlationId ? sessions.getDbIdByToken(correlationId) : Number(event.sessionId) || null;

  if (event.type === 'turn.completed') {
    return signalStop({
      sessionId: correlationId || event.externalSessionId || null,
      cwd: event.cwd,
      lastAssistantMessage: event.responseText ?? event.text,
      stopReason: event.stopReason,
      transcriptPath: event.transcriptPath,
    });
  }
  if (dbId == null || !sessions.getSession(dbId)) throw new Error('event does not identify a live harness session');

  if (event.externalSessionId) sessions.setExternalSessionId(dbId, event.externalSessionId);
  if (event.type === 'turn.started') sessions.markState(dbId, 'busy');
  else if (event.type === 'prompt.requested' || event.type === 'auth.required') sessions.markState(dbId, 'awaiting_input');
  else if (event.type === 'turn.failed') sessions.markState(dbId, 'failed');
  else if (event.type === 'agent.exited') sessions.markState(dbId, 'dead');
  return true;
}
