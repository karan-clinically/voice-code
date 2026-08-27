import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeProviderSessions,
  isBackgroundAgentSession,
  liveHarnessForConversation,
  processForHarnessSession,
  uniqueSessionLabel,
} from '../src/services/sessionIdentity.js';

test('a background agent sharing a cwd does not hide an ordinary harness session', () => {
  const backgroundIds = new Set(['agent-uuid']);
  const ordinary = { cwd: 'C:\\AI', sessionId: 'interactive-uuid', agentView: false };
  assert.equal(isBackgroundAgentSession(ordinary, backgroundIds), false);
  assert.equal(isBackgroundAgentSession({ ...ordinary, sessionId: 'agent-uuid' }, backgroundIds), true);
  assert.equal(isBackgroundAgentSession({ ...ordinary, agentView: true }, backgroundIds), true);
});

test('a live harness conversation can be resolved before its UUID reaches the database', () => {
  const sessions = [
    { id: 12, alive: true, kind: 'claude', pid: 4400, claude_session_id: null },
  ];
  const processes = [{ pid: 4400, sessionId: 'conversation-uuid' }];
  assert.equal(liveHarnessForConversation(sessions, 'conversation-uuid', processes)?.id, 12);
  assert.equal(processForHarnessSession(sessions[0], processes)?.sessionId, 'conversation-uuid');
});

test('directory and title matches alone never establish conversation identity', () => {
  const sessions = [
    { id: 9, alive: true, kind: 'claude', pid: 99, cwd: 'C:\\AI', label: 'Same title' },
  ];
  const processes = [{ pid: 100, sessionId: 'wanted', cwd: 'C:\\AI', name: 'Same title' }];
  assert.equal(liveHarnessForConversation(sessions, 'wanted', processes), null);
});

test('the same external id never collapses sessions from different providers', () => {
  const rows = [
    { key: 'h1', agentKind: 'claude', sessionId: 'same-id', ts: '2026-01-01T00:00:00Z' },
    { key: 'h2', agentKind: 'codex', sessionId: 'same-id', ts: '2026-01-01T00:00:01Z' },
  ];
  assert.deepEqual(dedupeProviderSessions(rows).map((row) => row.key), ['h1', 'h2']);
  assert.equal(liveHarnessForConversation([
    { id: 2, alive: true, kind: 'codex', external_session_id: 'same-id' },
  ], 'same-id', []), null);
});

test('new session labels are unique within their folder', () => {
  const rows = [
    { alive: true, cwd: 'C:\\AI\\library', label: 'library · Codex CLI' },
    { alive: true, cwd: 'c:/ai/library/', label: 'library · Codex CLI 3' },
    { alive: true, cwd: 'C:\\AI\\other', label: 'library · Codex CLI 2' },
  ];
  assert.equal(uniqueSessionLabel(rows, 'C:\\AI\\library\\', 'library · Codex CLI'), 'library · Codex CLI 2');
  assert.equal(uniqueSessionLabel(rows, 'C:\\AI\\library', 'A fresh name'), 'A fresh name');
});
