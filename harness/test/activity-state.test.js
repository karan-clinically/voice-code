import test from 'node:test';
import assert from 'node:assert/strict';
import { screenShowsWorking } from '../src/services/activityState.js';

test('detects Claude rotating spinner verbs as working', () => {
  assert.equal(screenShowsWorking(`
· Whisking… (8m 9s · ↓ 30.7k tokens)

────────────────────
> `), true);
});

test('detects adapter-provided working text', () => {
  assert.equal(screenShowsWorking('Thinking…', ['thinking…']), true);
});

test('does not treat a completed prompt as working', () => {
  assert.equal(screenShowsWorking('Done.\n\n────────────────────\n> '), false);
});
