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

test('custom provider definitions reject unsafe or unsupported launch fields', async () => {
  process.env.CVH_DATA_DIR = join(tmpdir(), `cvh-custom-validation-${randomUUID()}`);
  const { validateCustomDefinition } = await import('../src/agents/registry.js');
  assert.throws(() => validateCustomDefinition({
    id: 'bad-endpoint', name: 'Bad', type: 'anthropic', endpoint: 'file:///secret', model: 'x',
  }), /http or https/);
  assert.throws(() => validateCustomDefinition({
    id: 'bad-command', name: 'Bad', type: 'cli', command: 'agent\nmalicious',
  }), /invalid command/);
});

test('built-in providers expose normalized public contracts', async () => {
  process.env.CVH_DATA_DIR = join(tmpdir(), `cvh-adapter-test-${randomUUID()}`);
  const { listAdapters, publicAdapter, removeCustomProvider, requireAdapter, saveCustomProvider } = await import('../src/agents/registry.js');
  const providers = listAdapters();
  assert.deepEqual(providers.map((p) => p.id), ['claude', 'grok', 'codex', 'kimi-k3']);
  for (const provider of providers) {
    assert.equal(provider.capabilities.terminal, true);
    assert.ok(Array.isArray(provider.authentication.methods));
  }
  const codex = requireAdapter('codex').buildLaunchSpec({ cwd: process.cwd() });
  assert.ok(codex.args.includes('--yolo'));
  assert.equal(requireAdapter('codex').capabilities.rename, true);
  assert.equal(requireAdapter('codex').buildRenameInput('auth refactor'), '/rename auth refactor');
  assert.equal(requireAdapter('claude').buildRenameInput('auth refactor'), '/rename auth refactor');

  const custom = saveCustomProvider({
    id: 'local-brain',
    name: 'Local Brain',
    type: 'anthropic',
    endpoint: 'http://127.0.0.1:11434/anthropic/',
    model: 'example-model',
  });
  const publicCustom = publicAdapter(custom);
  assert.equal(publicCustom.configurable, true);
  assert.equal(publicCustom.configuration.endpoint, 'http://127.0.0.1:11434/anthropic');
  assert.equal(publicCustom.authentication.status, 'required');
  const launch = custom.buildLaunchSpec({ cwd: process.cwd() });
  assert.equal(launch.env.ANTHROPIC_MODEL, 'example-model');
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, undefined);
  removeCustomProvider('local-brain');
});

test('Claude sessions prefer the full-scope CLI login over environment tokens', async () => {
  process.env.CVH_DATA_DIR = join(tmpdir(), `cvh-claude-auth-test-${randomUUID()}`);
  const { allAdapters, requireAdapter } = await import('../src/agents/registry.js');
  const { spawnEnvironment } = await import('../src/agents/credentials.js');
  const policy = spawnEnvironment(requireAdapter('claude'), allAdapters());

  assert.ok(policy.removeEnv.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(policy.removeEnv.includes('ANTHROPIC_API_KEY'));
});
