import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTextInput } from '../src/services/terminal.js';

test('large terminal input is chunked without truncation', () => {
  const source = `${'large prompt '.repeat(1200)}END`;
  const input = prepareTextInput(source, 257);
  assert.equal(input.bracketed, true);
  assert.equal(input.chunks.join(''), source);
  assert.ok(input.chunks.length > 1);
  assert.equal(input.chunks.at(-1).endsWith('END'), true);
});

test('multiline paste preserves newlines and unicode while stripping terminal controls', () => {
  const source = 'first line\nsecond 😀 line\tindented\x1b[31m';
  const input = prepareTextInput(source, 20);
  assert.equal(input.bracketed, true);
  assert.equal(input.chunks.join(''), 'first line\nsecond 😀 line\tindented[31m');
});
