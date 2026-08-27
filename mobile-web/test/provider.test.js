import test from 'node:test';
import assert from 'node:assert/strict';
import { providerKindOf } from '../src/lib/provider.js';

test('uses the provider attached to a harness session', () => {
  assert.equal(providerKindOf({ kind: 'harness', agentKind: 'codex' }), 'codex');
  assert.equal(providerKindOf({ kind: 'harness', agentKind: 'kimi-k3' }), 'kimi-k3');
});

test('maps saved Grok and legacy discovered Claude rows', () => {
  assert.equal(providerKindOf({ kind: 'grok-saved' }), 'grok');
  assert.equal(providerKindOf({ kind: 'code', origin: 'terminal' }), 'claude');
  assert.equal(providerKindOf({ kind: 'code', origin: 'cloud' }), 'claude');
});

test('keeps shell and custom providers distinct', () => {
  assert.equal(providerKindOf({ shell: true, agentKind: 'claude' }), 'shell');
  assert.equal(providerKindOf({ kind: 'harness', agentKind: 'local-model' }), 'local-model');
});
