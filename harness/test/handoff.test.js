import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffPrompt } from '../src/services/handoff.js';

test('handoff prompt carries recent intent, provider identity, and workspace state', () => {
  const prompt = buildHandoffPrompt({
    source: {
      id: 7,
      label: 'Voice Harness fixes',
      kind: 'claude',
      cwd: 'C:\\AI\\voice harness',
      git_branch: 'main',
      provider: { name: 'Claude Code' },
    },
    targetProvider: { id: 'codex', name: 'Codex CLI' },
    messages: [
      { role: 'user', text: 'Add a switch LLM button.' },
      { role: 'activity', text: 'Read files' },
      { role: 'assistant', text: 'I will implement a linked handoff.' },
    ],
    workspace: {
      status: '## main\n M harness/src/server/routes/sessions.js',
      stat: '1 file changed',
      diff: '+router.post(\'/:id/handoff\')',
    },
  });

  assert.match(prompt, /taking over.*Claude Code/i);
  assert.match(prompt, /Continue the same task as Codex CLI/);
  assert.match(prompt, /User:\nAdd a switch LLM button/);
  assert.match(prompt, /Assistant:\nI will implement a linked handoff/);
  assert.doesNotMatch(prompt, /Read files/);
  assert.match(prompt, /M harness\/src\/server\/routes\/sessions\.js/);
  assert.match(prompt, /Do not undo existing changes/);
});

test('handoff prompt keeps the newest conversation when the transcript is large', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `message-${index} ${'x'.repeat(1200)}`,
  }));
  const prompt = buildHandoffPrompt({ source: { id: 1 }, targetProvider: { id: 'codex' }, messages, workspace: {} });
  assert.doesNotMatch(prompt, /message-0 /);
  assert.match(prompt, /message-19 /);
  assert.match(prompt, /earlier content omitted/);
});
