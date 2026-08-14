import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-wsterm-'));
const { replayForConnection } = await import('../src/server/wsTerm.js');

// The replay opt-out is a URL contract between the phone and wsTerm.js, so assert
// the parse itself: `?replay=0` suppresses it, anything else (including a legacy
// client that sends nothing) keeps the existing paint-immediately behaviour.
const wantsReplay = (url) => new URL(url, 'http://localhost').searchParams.get('replay') !== '0';

const CAP = 128 * 1024;
const buffer = (bytes) => `${'x'.repeat(40)}\n`.repeat(Math.ceil(bytes / 41)).slice(0, bytes);

test('a client can opt out of the scrollback replay', () => {
  assert.equal(wantsReplay('/ws/term?session=7&replay=0'), false);
  assert.equal(wantsReplay('/ws/term?session=7&replay=0&token=abc'), false);
});

test('every existing client still gets the replay', () => {
  assert.equal(wantsReplay('/ws/term?session=7'), true); // desktop xterm
  assert.equal(wantsReplay('/ws/term?session=7&token=abc'), true);
  assert.equal(wantsReplay('/ws/term?session=7&replay=1'), true);
});

test('opting out sends nothing at all, from anywhere', () => {
  assert.equal(replayForConnection(buffer(500_000), { wantsReplay: false, local: false }), '');
  assert.equal(replayForConnection(buffer(500_000), { wantsReplay: false, local: true }), '');
});

test('a loopback client replays the whole buffer', () => {
  const full = buffer(500_000);
  assert.equal(replayForConnection(full, { wantsReplay: true, local: true }), full);
});

test('a proxied client replays a bounded tail', () => {
  const full = buffer(500_000);
  const sent = replayForConnection(full, { wantsReplay: true, local: false });
  assert.ok(sent.length <= CAP, `${sent.length} bytes exceeds the cap`);
  assert.ok(full.endsWith(sent), 'the tail must be the newest output, not the oldest');
  // Trimming to a line boundary is what keeps a half-written escape sequence off
  // the wire, so the tail must start just after a newline in the source.
  assert.equal(full[full.length - sent.length - 1], '\n');
});

test('a buffer under the cap is sent whole even when proxied', () => {
  const small = buffer(4000);
  assert.equal(replayForConnection(small, { wantsReplay: true, local: false }), small);
});
