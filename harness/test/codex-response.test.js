import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeCodexResponse } from '../src/services/claudeCode.js';

test('Codex response extraction selects the final assistant block, not the user prompt', () => {
  const screen = [
    '› explain why the playback failed',
    '',
    '• I am checking the audio path.',
    '',
    '• The playback failed because the page slept. I updated the wake lock and replay state.',
    '  The spoken clip now uses the assistant result.',
    '',
    '›',
    '  ? for shortcuts',
  ].join('\n');

  assert.equal(
    scrapeCodexResponse(screen, 'explain why the playback failed'),
    'The playback failed because the page slept. I updated the wake lock and replay state.\n  The spoken clip now uses the assistant result.'
  );
});

test('Codex response extraction never falls back to speaking an echoed prompt', () => {
  const screen = [
    '› write a concise summary',
    '',
    '›',
  ].join('\n');

  assert.equal(scrapeCodexResponse(screen, 'write a concise summary'), '');
});
