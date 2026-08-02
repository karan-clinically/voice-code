import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'cvh-preview-db-'));
process.env.CVH_DATA_DIR = dataDir;
const { discoverPreview, previewSpawn } = await import('../src/services/previewManager.js');

function project(name) {
  const dir = join(dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('discovers an explicit preview configuration', () => {
  const dir = project('explicit');
  writeFileSync(join(dir, '.voice-harness.json'), JSON.stringify({
    preview: { command: 'npm', args: ['run', 'serve', '--', '--port', '{port}'], readyPath: '/health' },
  }));
  assert.deepEqual(discoverPreview(dir), {
    type: 'process', command: 'npm', args: ['run', 'serve', '--', '--port', '{port}'],
    readyPath: '/health', source: '.voice-harness.json',
  });
});

test('adds host and strict dynamic-port arguments for Vite', () => {
  const dir = project('vite');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' },
  }));
  const found = discoverPreview(dir);
  assert.equal(found.type, 'process');
  assert.equal(found.source, 'package.json#dev');
  assert.deepEqual(found.args.slice(-6), ['--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort']);
});

test('serves a plain index.html folder as static content', () => {
  const dir = project('static');
  writeFileSync(join(dir, 'index.html'), '<h1>hello</h1>');
  assert.deepEqual(discoverPreview(dir), { type: 'static', readyPath: '/', source: 'index.html' });
});

test('returns null for folders without a previewable app', () => {
  assert.equal(discoverPreview(project('empty')), null);
});

// Node blocks spawning .cmd shims like npm.cmd without a shell (CVE-2024-27980
// mitigation); previewSpawn must route through cmd.exe or every process preview
// fails at startup with `spawn EINVAL`.
test('previewSpawn can launch the npm shim', { skip: process.platform !== 'win32' }, async () => {
  const child = previewSpawn('npm.cmd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('exit', resolveCode);
  });
  assert.equal(code, 0);
});
