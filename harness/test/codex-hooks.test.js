import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-codex-hooks-'));

const {
  CODEX_HOOK_EVENTS,
  codexHookToAgentEvent,
  mergeCodexHooks,
} = await import('../src/services/codexHooks.js');
const sessions = await import('../src/services/sessionManager.js');
const { acceptAgentEvent } = await import('../src/services/agentEvents.js');
const { getAttention } = await import('../src/services/attention.js');
// Register the production state -> sticky-attention listener.
await import('../src/services/notify.js');

const created = [];

test.after(() => {
  for (const id of created) {
    try { sessions.killSession(id); } catch { /* already gone */ }
  }
  try { rmSync(process.env.CVH_DATA_DIR, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

test('Codex hooks translate to canonical events only for harness-owned sessions', () => {
  const common = { session_id: 'thr_123', cwd: 'C:\\work', turn_id: 'turn_1' };
  assert.equal(codexHookToAgentEvent({ ...common, hook_event_name: 'Stop' }, {}), null);
  assert.deepEqual(
    codexHookToAgentEvent(
      { ...common, hook_event_name: 'Stop', last_assistant_message: 'Done.' },
      { CVH_SESSION_ID: 'cvh-token' }
    ),
    {
      type: 'turn.completed',
      correlationId: 'cvh-token',
      externalSessionId: 'thr_123',
      cwd: 'C:\\work',
      responseText: 'Done.',
      transcriptPath: null,
      turnId: 'turn_1',
      toolName: null,
    }
  );
});

test('setup merge preserves other Codex hooks and is idempotent', () => {
  const scriptPath = 'C:\\voice harness\\harness\\bin\\codex-hook.mjs';
  const command = `node "${scriptPath}"`;
  const custom = { type: 'command', command: 'node custom-hook.mjs' };
  const initial = { description: 'mine', hooks: { Stop: [{ hooks: [custom] }] } };
  const once = mergeCodexHooks(initial, { command, scriptPath });
  const twice = mergeCodexHooks(once, { command, scriptPath });

  for (const eventName of CODEX_HOOK_EVENTS) {
    const handlers = twice.hooks[eventName].flatMap((group) => group.hooks);
    assert.equal(handlers.filter((handler) => handler.command.includes(scriptPath)).length, 1);
  }
  assert.ok(twice.hooks.Stop.some((group) => group.hooks.includes(custom)), 'custom Stop hook survives');

  const removed = mergeCodexHooks(twice, { command, scriptPath, uninstall: true });
  assert.deepEqual(removed, initial);
});

test('canonical Codex events drive the states and mobile attention badges', async () => {
  const session = await sessions.createSession({ cwd: process.env.CVH_DATA_DIR, kind: 'shell' });
  created.push(session.id);
  const correlationId = sessions.getToken(session.id);

  acceptAgentEvent({ type: 'turn.started', correlationId });
  assert.equal(sessions.getSession(session.id).state, 'busy');
  assert.equal(getAttention(session.id), null);

  acceptAgentEvent({ type: 'prompt.requested', correlationId });
  assert.equal(sessions.getSession(session.id).state, 'awaiting_input');
  assert.equal(getAttention(session.id)?.kind, 'input');

  acceptAgentEvent({
    type: 'turn.completed',
    correlationId,
    externalSessionId: 'thr_codex',
    cwd: process.env.CVH_DATA_DIR,
  });
  assert.equal(sessions.getSession(session.id).state, 'response_ready');
  assert.equal(sessions.getSession(session.id).external_session_id, 'thr_codex');
  assert.equal(getAttention(session.id)?.kind, 'finished');

  acceptAgentEvent({ type: 'turn.started', correlationId });
  acceptAgentEvent({ type: 'turn.failed', correlationId });
  assert.equal(sessions.getSession(session.id).state, 'failed');
  assert.equal(getAttention(session.id)?.kind, 'failed');
});
