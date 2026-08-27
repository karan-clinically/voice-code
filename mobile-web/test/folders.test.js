import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByFolder, uniqueLabelInFolder } from '../src/lib/folders.js';

test('same-name sessions remain separate rows in one folder', () => {
  const rows = [
    { key: 'h1', cwd: 'C:\\AI\\library', name: 'Same name', agentKind: 'claude' },
    { key: 'h2', cwd: 'C:\\AI\\library', name: 'Same name', agentKind: 'codex' },
  ];
  const [folder] = groupByFolder(rows);
  assert.deepEqual(folder.items.map((row) => row.key), ['h1', 'h2']);
});

test('mobile assigns the next available name before creating a session', () => {
  const rows = [
    { alive: true, cwd: 'C:\\AI\\library', name: 'library · Codex CLI' },
    { alive: true, cwd: 'c:/ai/library/', name: 'library · Codex CLI 3' },
  ];
  assert.equal(
    uniqueLabelInFolder(rows, 'C:\\AI\\library\\', 'library · Codex CLI'),
    'library · Codex CLI 2'
  );
});
