import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTerminalActivity } from '../src/services/prompt.js';

test('foreground shell batches surface background and stop actions', () => {
  const activity = detectTerminalActivity(`
Searching for 1 pattern, running 8 shell commands…
  ⎿ $ curl https://example.test/data

✻ Cerebrating… (6m 17s · thinking)
`);
  assert.equal(activity?.kind, 'foreground-shell');
  assert.equal(activity?.canBackground, true);
  assert.equal(activity?.canStop, true);
  assert.match(activity?.detail, /6m 17s/);
});

test('recent shell failures surface a stop action', () => {
  const activity = detectTerminalActivity(`
⎿ Shell command failed with exit code 2
❯
`);
  assert.equal(activity?.kind, 'shell-failed');
  assert.equal(activity?.canBackground, false);
  assert.equal(activity?.canStop, true);
});

test('ordinary completed output has no terminal activity', () => {
  assert.equal(detectTerminalActivity('Done.\n\n❯'), null);
});
