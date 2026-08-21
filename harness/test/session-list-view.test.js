import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-sessview-'));
const { clientSessionView } = await import('../src/services/sessionManager.js');

// Every session ever created stays in the table, and /ws re-broadcasts the list on
// every state change — so what CLIENTS get has to be bounded even though
// listSessions() itself stays complete for the internal lookups that scan it.
const at = (mins) => new Date(Date.UTC(2026, 7, 15, 0, mins)).toISOString();
const session = (id, alive, mins) => ({ id, alive, last_seen_at: at(mins) });

test('every live session survives the cap, however many there are', () => {
  const all = Array.from({ length: 40 }, (_, i) => session(i + 1, true, i));
  assert.equal(clientSessionView(all, 5).length, 40);
});

test('dead sessions are capped to the most recently seen', () => {
  const all = [
    session(1, false, 10),
    session(2, false, 50), // newest dead
    session(3, true, 5),
    session(4, false, 30),
  ];
  const view = clientSessionView(all, 2);
  assert.deepEqual(view.map((s) => s.id), [2, 3, 4], 'kept in the original order, not re-sorted');
  assert.equal(view.some((s) => s.id === 1), false, 'the oldest dead row is the one dropped');
});

test('a session that just exited is still there for the UI to render', () => {
  const all = [session(1, false, 99), session(2, true, 98)];
  assert.equal(clientSessionView(all, 20).some((s) => s.id === 1), true);
});

test('a dead row with no timestamp cannot crash the sort', () => {
  const all = [{ id: 1, alive: false }, session(2, true, 5), session(3, false, 9)];
  const view = clientSessionView(all, 1);
  assert.equal(view.length, 2);
  assert.deepEqual(view.map((s) => s.id), [2, 3]);
});
