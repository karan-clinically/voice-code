import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adapterFromManifest, validateAdapter } from '../src/agents/contract.js';

test('a declarative manifest produces a shell-free launch specification', () => {
  const adapter = adapterFromManifest({
    id: 'fake-cli',
    name: 'Fake CLI',
    command: process.execPath,
    args: ['fake.js', '--cwd', '{cwd}'],
    resumeArgs: ['fake.js', '--resume', '{externalSessionId}'],
    capabilities: { terminal: true, resume: true },
  });

  assert.deepEqual(adapter.buildLaunchSpec({ cwd: 'C:\\work', resumeId: null }), {
    command: process.execPath,
    args: ['fake.js', '--cwd', 'C:\\work'],
    env: {},
    externalSessionId: null,
  });
  assert.deepEqual(adapter.buildLaunchSpec({ cwd: 'C:\\work', resumeId: 'abc' }).args, [
    'fake.js', '--resume', 'abc',
  ]);
  assert.equal(adapter.capabilities.chat, false);
  assert.equal(adapter.capabilities.resume, true);
});

test('invalid adapters are rejected at registration boundaries', () => {
  assert.throws(() => validateAdapter({ id: '../bad', name: 'Bad', buildLaunchSpec() {} }), /invalid adapter id/);
  assert.throws(() => validateAdapter({ id: 'valid', name: 'Valid' }), /buildLaunchSpec/);
});

test('built-in providers expose normalized public contracts', async () => {
  process.env.CVH_DATA_DIR = join(tmpdir(), `cvh-adapter-test-${randomUUID()}`);
  const { listAdapters, requireAdapter } = await import('../src/agents/registry.js');
  const providers = listAdapters();
  assert.deepEqual(providers.map((p) => p.id), ['claude', 'grok', 'codex']);
  for (const provider of providers) {
    assert.equal(provider.capabilities.terminal, true);
    assert.ok(Array.isArray(provider.authentication.methods));
  }
  const codex = requireAdapter('codex').buildLaunchSpec({ cwd: process.cwd() });
  assert.ok(codex.args.includes('--yolo'));
});
