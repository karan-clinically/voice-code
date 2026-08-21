import test from 'node:test';
import assert from 'node:assert/strict';
import { screenShowsWorking, screenState } from '../src/services/activityState.js';

// A picker Claude is waiting on. Its footer says "esc to cancel" — the working
// spinner says "esc to interrupt", which is how the two are told apart.
const PICKER = [
  '╭──────────────────────────────────────────╮',
  '│ Do you want to make this edit to db.js?  │',
  '│                                          │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, tell Claude what to do instead  │',
  '╰──────────────────────────────────────────╯',
  '  esc to cancel',
].join('\n');

test('detects Claude rotating spinner verbs as working', () => {
  assert.equal(screenShowsWorking(`
· Whisking… (8m 9s · ↓ 30.7k tokens)

────────────────────
> `), true);
});

// Claude cycles the leading glyph through six frames while a turn runs; missing
// any of them makes the badge intermittently drop to idle mid-turn (✢ was missing
// until this was caught against a live session).
test('detects every spinner glyph Claude actually cycles through', () => {
  for (const glyph of ['·', '✢', '✻', '✽', '✶', '*']) {
    assert.equal(screenShowsWorking(`${glyph} Whisking… (8m 9s · ↓ 30.7k tokens)`), true, `glyph ${glyph}`);
  }
});

test('detects adapter-provided working text', () => {
  assert.equal(screenShowsWorking('Thinking…', ['thinking…']), true);
});

test('does not treat a completed prompt as working', () => {
  assert.equal(screenShowsWorking('Done.\n\n────────────────────\n> '), false);
});

test('a picker on screen means waiting on a decision, not working', () => {
  assert.equal(screenState(PICKER), 'awaiting_input');
});

// The spinner can still be on screen above a freshly drawn picker; the decision
// is what the user needs to see, so it wins.
test('a picker outranks a spinner still on screen', () => {
  const screen = '· Whisking… (8m 9s · ↓ 30.7k tokens)\n' + PICKER;
  assert.equal(screenState(screen), 'awaiting_input');
});

test('a spinner alone still reports working', () => {
  assert.equal(screenState('· Whisking… (8m 9s · ↓ 30.7k tokens)\n\n> '), 'busy');
});

test('an idle prompt reports nothing, leaving the state alone', () => {
  assert.equal(screenState('Done.\n\n────────────────────\n> '), null);
});
