import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBackgroundAgentSession,
  liveHarnessForConversation,
  processForHarnessSession,
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
