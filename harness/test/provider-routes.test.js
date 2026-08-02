import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-provider-route-'));
const { buildApp } = await import('../src/server/http.js');

let server;
let base;

test.before(async () => {
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function json(path, options) {
  const response = await fetch(base + path, options);
  const body = await response.json();
  return { response, body };
}

test('custom provider CRUD hot-loads definitions without exposing credentials', async () => {
  const secret = 'super-secret-provider-key';
  const created = await json('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'route-brain',
      name: 'Route Brain',
      type: 'anthropic',
      endpoint: 'https://brain.example/anthropic',
      model: 'brain-v1',
      credential: secret,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.provider.authentication.configured, true);
  assert.equal(JSON.stringify(created.body).includes(secret), false);

  const listed = await json('/api/providers');
  const provider = listed.body.providers.find((item) => item.id === 'route-brain');
  assert.equal(provider.configuration.model, 'brain-v1');
  assert.equal(JSON.stringify(provider).includes(secret), false);

  const manifest = readFileSync(join(process.env.CVH_DATA_DIR, 'agents', 'route-brain.json'), 'utf8');
  assert.equal(manifest.includes(secret), false);

  const removed = await json('/api/providers/route-brain', { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  const after = await json('/api/providers');
  assert.equal(after.body.providers.some((item) => item.id === 'route-brain'), false);
});
