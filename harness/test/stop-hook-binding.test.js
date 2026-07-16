// Two live sessions in ONE folder is the case that broke the phone's session list:
// the Stop hook used to be matched to a row by cwd, and on a tie it took the newest
// row. So the older session's claude_session_id never refreshed, went stale, escaped
// the by-UUID dedupe in /recent, and showed up as a second card that resumed an
// older fork of the same conversation. The CVH_SESSION_ID token is the exact link
// that tells the two apart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-test-'));

const sessions = await import('../src/services/sessionManager.js');
const { signalStop } = await import('../src/services/claudeCode.js');

const CWD = process.env.CVH_DATA_DIR;
const created = [];

async function spawnShell() {
  const s = await sessions.createSession({ cwd: CWD, kind: 'shell' });
  created.push(s.id);
  return s;
}

test.after(() => {
  for (const id of created) {
    try {
      sessions.killSession(id);
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(process.env.CVH_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* windows file locks */
  }
});

test('the Stop hook binds to its own session, not the newest one in the folder', async () => {
  const older = await spawnShell();
  const newer = await spawnShell();
  assert.ok(newer.id > older.id, 'second session should be the newer row');

  const olderToken = sessions.getToken(older.id);
  assert.ok(olderToken, 'a spawned session has a correlation token');

  // The OLDER session finishes a turn. Its token must win over the cwd tie-break.
  signalStop({ sessionId: 'uuid-older', token: olderToken, cwd: CWD });

  assert.equal(sessions.getSession(older.id).claude_session_id, 'uuid-older');
  assert.equal(
    sessions.getSession(newer.id).claude_session_id,
    null,
    'the newest row must not absorb another session\'s UUID'
  );
});

test('a rotated transcript UUID refreshes rather than going stale', async () => {
  const s = await spawnShell();
  const token = sessions.getToken(s.id);

  signalStop({ sessionId: 'uuid-before-resume', token, cwd: CWD });
  assert.equal(sessions.getSession(s.id).claude_session_id, 'uuid-before-resume');

  // A --resume or /compact starts a new transcript; the row must follow it.
  signalStop({ sessionId: 'uuid-after-resume', token, cwd: CWD });
  assert.equal(sessions.getSession(s.id).claude_session_id, 'uuid-after-resume');
});

test('a Claude the harness did not spawn still matches by cwd', async () => {
  const s = await spawnShell();
  signalStop({ sessionId: 'uuid-no-token', token: null, cwd: CWD });
  assert.equal(sessions.getSession(s.id).claude_session_id, 'uuid-no-token');
});
