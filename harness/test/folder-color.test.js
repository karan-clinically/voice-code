import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-folder-color-'));
const { folderColorFrom, folderKey } = await import('../src/services/sessionManager.js');

// Rows arrive newest first, the way the query returns them.
const rows = [
  { cwd: String.raw`C:\AI\library`, tab_color: '#7c3aed' },
  { cwd: String.raw`C:\AI\voice harness`, tab_color: '#3fb950' },
  { cwd: String.raw`C:\AI\voice harness`, tab_color: '#d97706' }, // older choice, same folder
];

test('a new session inherits the colour its folder already uses', () => {
  assert.equal(folderColorFrom(rows, String.raw`C:\AI\voice harness`), '#3fb950');
});

test('the most recent choice for a folder wins', () => {
  assert.notEqual(folderColorFrom(rows, String.raw`C:\AI\voice harness`), '#d97706');
});

test('a folder nobody has coloured stays uncoloured', () => {
  assert.equal(folderColorFrom(rows, String.raw`C:\AI\brand new`), null);
  assert.equal(folderColorFrom(rows, ''), null);
  assert.equal(folderColorFrom([], String.raw`C:\AI\library`), null);
});

// The same directory reaches the harness spelled several ways: a folder picker
// adds a trailing slash, a shell reports a different drive-letter case.
test('the same folder spelled differently is still the same folder', () => {
  assert.equal(folderColorFrom(rows, String.raw`c:\ai\voice harness`), '#3fb950');
  assert.equal(folderColorFrom(rows, 'C:\\AI\\voice harness\\'), '#3fb950');
  assert.equal(folderKey('C:/AI/Library/'), folderKey('c:/ai/library'));
});

test('a sibling folder does not borrow the colour', () => {
  assert.equal(folderColorFrom(rows, String.raw`C:\AI\voice harness 2`), null);
});
