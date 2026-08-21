import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt, promptToText, multiSelectPlan } from '../src/services/prompt.js';

test('picker speech retains explanatory context before the answer options', () => {
  const prompt = detectPrompt(`
│ The production database has unapplied migrations. Deploying now could leave
│ existing workers on the previous schema.
│
│ How should Claude handle the deployment?
│
│ ❯ 1. Stop here   Leave production unchanged
│   2. Run migrations   Apply them before deploying
│   3. Deploy anyway   Accept the compatibility risk
│
  Enter to confirm · Esc to cancel
`);

  assert.equal(prompt?.question, 'How should Claude handle the deployment?');
  assert.match(prompt?.context || '', /production database has unapplied migrations/i);
  assert.equal(prompt?.options[1].description, 'Apply them before deploying');
  assert.match(promptToText(prompt), /Context: The production database/i);
  assert.match(promptToText(prompt), /How should Claude handle the deployment\?/i);
});

test('wrapped picker questions are reconstructed instead of falling back to options only', () => {
  const prompt = detectPrompt(`
╭────────────────────────────────────────╮
│ Which authentication approach should I
│ use for the mobile client?
│
│ ❯ 1. Passkey
│   2. Magic link
╰────────────────────────────────────────╯
  Esc to cancel
`);

  assert.equal(prompt?.question, 'Which authentication approach should I use for the mobile client?');
  assert.equal(prompt?.context, '');
});

test('a bash permission dialog is spoken as its intent, never as the command', () => {
  const prompt = detectPrompt(`
╭──────────────────────────────────────────────────────────╮
│ Bash command                                             │
│                                                          │
│   git push origin main --force-with-lease                │
│   Push the current branch to origin                      │
│                                                          │
│ Do you want to proceed?                                  │
│ ❯ 1. Yes                                                 │
│   2. Yes, and don't ask again for git push commands in C:\AI\voice harness
│   3. No, and tell Claude what to do differently (esc)    │
╰──────────────────────────────────────────────────────────╯
  Enter to confirm · Esc to cancel
`);

  const speech = prompt.speech;
  assert.match(speech, /do you want to allow it\?/i);
  assert.match(speech, /push these changes/i);
  assert.doesNotMatch(speech, /origin main|force-with-lease|git push/i, 'the command must not be spoken');
  assert.doesNotMatch(speech, /voice harness/i, 'nor the path buried in the "don\'t ask again" option');
  assert.match(speech, /1\. Yes/);
  assert.match(speech, /3\. No\./, 'options stay numbered so they can be answered by voice');
  // The screen text still carries the exact command — this only changes what is heard.
  assert.match(promptToText(prompt), /force-with-lease/);
});

test('other commands map to their own gist, unknown ones to a generic one', () => {
  const speechFor = (cmd) =>
    detectPrompt(`
│ Bash command
│
│   ${cmd}
│
│ Do you want to proceed?
│ ❯ 1. Yes
│   2. No
  Esc to cancel
`).speech;

  assert.match(speechFor('npm install left-pad'), /install dependencies/i);
  assert.match(speechFor('rm -rf dist'), /delete some files/i);
  assert.match(speechFor('pytest tests/'), /run the tests/i);
  assert.match(speechFor('gh pr create --fill'), /open a pull request/i);
  assert.match(speechFor('frobnicate --all'), /run a command/i);
  assert.doesNotMatch(speechFor('frobnicate --all'), /frobnicate/i);
});

test('an ordinary question is still spoken in full', () => {
  const prompt = detectPrompt(`
│ Which authentication approach should I use?
│
│ ❯ 1. Passkey   Hardware backed
│   2. Magic link   Email round trip
  Esc to cancel
`);

  assert.match(prompt.speech, /Which authentication approach should I use\?/i);
  assert.match(prompt.speech, /1\. Passkey\. Hardware backed/i);
});

test('a question keeps its own context only when nothing else will be read first', () => {
  const prompt = detectPrompt(`
│ The production database has unapplied migrations. Deploying now could leave
│ existing workers on the previous schema.
│
│ How should Claude handle the deployment?
│
│ ❯ 1. Stop here   Leave production unchanged
│   2. Run migrations   Apply them before deploying
  Esc to cancel
`);

  // Standalone: the context is the only background the listener gets.
  assert.match(prompt.speech, /unapplied migrations/i);
  // Appended after a spoken summary of the same findings, it would say it twice.
  assert.doesNotMatch(prompt.ask, /unapplied migrations/i);
  assert.match(prompt.ask, /How should Claude handle the deployment\?/i);
  assert.match(prompt.ask, /1\. Stop here/);
  assert.equal(prompt.permission, false, 'a question, not a command to allow');
});

test('a permission dialog is marked as one so it keeps its one-line form', () => {
  const prompt = detectPrompt(`
│ Bash command
│
│   git push origin main
│
│ Do you want to proceed?
│ ❯ 1. Yes
│   2. No
  Esc to cancel
`);

  assert.equal(prompt.permission, true);
  assert.equal(prompt.ask, prompt.speech, 'nothing precedes it, so both forms are the intent');
  assert.doesNotMatch(prompt.ask, /git push/i);
});

// Multi-select answering: Space flips whatever the cursor is on, so the plan is
// "walk the list, flip only what differs" — never "set", which the TUI has no
// primitive for.
const picker = (opts, cursorN = 1) => ({ cursorN, options: opts.map((o) => ({ n: o.n, selected: !!o.selected })) });

test('a multi-select plan flips only the options that differ', () => {
  const prompt = picker([{ n: 1, selected: true }, { n: 2 }, { n: 3, selected: true }]);
  // want {1,2}: 1 already on, 2 must go on, 3 must come off.
  assert.deepEqual(multiSelectPlan(prompt, [1, 2]), [
    { n: 2, moves: 1 },
    { n: 3, moves: 1 },
  ]);
});

test('an already-correct selection needs no keystrokes at all', () => {
  const prompt = picker([{ n: 1, selected: true }, { n: 2 }, { n: 3, selected: true }]);
  assert.deepEqual(multiSelectPlan(prompt, [1, 3]), []);
});

test('clearing every option walks them all', () => {
  const prompt = picker([{ n: 1, selected: true }, { n: 2, selected: true }], 2);
  assert.deepEqual(multiSelectPlan(prompt, []), [
    { n: 1, moves: -1 }, // cursor starts on 2, so the first move is upwards
    { n: 2, moves: 1 },
  ]);
});

test('moves are measured from where the cursor actually is', () => {
  const prompt = picker([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 3);
  assert.deepEqual(multiSelectPlan(prompt, [4]), [{ n: 4, moves: 1 }]);
});
