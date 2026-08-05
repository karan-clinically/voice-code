import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt, promptToText } from '../src/services/prompt.js';

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
