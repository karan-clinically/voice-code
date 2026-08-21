import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A transcript snapshot is the WHOLE conversation, and both phone surfaces poll
// it every few seconds — so on a long session the delta contract below is the
// difference between a few bytes and most of a megabyte per poll.
const projectsDir = mkdtempSync(join(tmpdir(), 'cvh-projects-'));
process.env.CVH_PROJECTS_DIR = projectsDir;
process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-conv-db-'));
const { getLiveConversation, getConversationPage } = await import('../src/services/conversation.js');

const UUID = '11111111-2222-3333-4444-555555555555';
const session = { id: 1, kind: 'claude', claude_session_id: UUID };
const transcriptPath = join(projectsDir, 'C--AI-demo', `${UUID}.jsonl`);

const turn = (text, role = 'assistant') =>
  JSON.stringify(
    role === 'user'
      ? { type: 'user', message: { role: 'user', content: text } }
      : { type: 'assistant', message: { content: [{ type: 'text', text }] } }
  );

mkdirSync(join(projectsDir, 'C--AI-demo'), { recursive: true });
writeFileSync(transcriptPath, [turn('first question', 'user'), turn('first answer')].join('\n'));

test('the opening read is the whole conversation, stamped with a version', async () => {
  const conv = await getLiveConversation(session, 0, { delta: true });
  assert.equal(conv.full, true);
  assert.equal(conv.messages.length, 2);
  assert.ok(conv.version, 'a version stamp is what lets the next poll skip the body');
});

test('an unchanged transcript answers with nothing at all', async () => {
  const first = await getLiveConversation(session, 0, { delta: true });
  const again = await getLiveConversation(session, first.lastId, { delta: true, version: first.version });
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.messages, []);
});

test('a delta carries the cursor message itself, because a streaming answer grows in place', async () => {
  const first = await getLiveConversation(session, 0, { delta: true });
  const tail = await getLiveConversation(session, first.lastId, { delta: true });
  assert.equal(tail.delta, true);
  assert.equal(tail.full, false, 'a tail is never a snapshot to replace with');
  assert.equal(tail.messages.length, 1);
  assert.equal(tail.messages[0].id, first.lastId);
  assert.equal(tail.messages[0].text, 'first answer');
});

test('new turns arrive as a tail, not another copy of the conversation', async () => {
  const before = await getLiveConversation(session, 0, { delta: true });
  appendFileSync(transcriptPath, '\n' + [turn('second question', 'user'), turn('second answer')].join('\n'));
  const tail = await getLiveConversation(session, before.lastId, { delta: true, version: before.version });
  assert.equal(tail.unchanged, undefined, 'the version moved, so this must not short-circuit');
  assert.notEqual(tail.version, before.version);
  assert.equal(tail.messages.length, 3); // the held last message plus the two new ones
  assert.deepEqual(tail.messages.map((m) => m.text), ['first answer', 'second question', 'second answer']);
});

test('a client that never asks for a delta still gets the whole snapshot', async () => {
  const conv = await getLiveConversation(session, 3);
  assert.equal(conv.full, true);
  assert.equal(conv.messages.length, 4);
});

test('the paged surface deltas too, and falls back to a full page on an unknown cursor', async () => {
  const page = await getConversationPage(session, { limit: 40 });
  assert.equal(page.full, true);
  assert.equal(page.messages.length, 4);

  const tail = await getConversationPage(session, { limit: 40, after: page.messages.at(-1).id });
  assert.equal(tail.delta, true);
  assert.equal(tail.messages.length, 1);

  const skipped = await getConversationPage(session, { limit: 40, after: 999 });
  assert.equal(skipped.full, true, 'a cursor that no longer exists must not silently return nothing');
  assert.equal(skipped.messages.length, 4);
});

test('an unchanged paged read skips the body as well', async () => {
  const page = await getConversationPage(session, { limit: 40 });
  const again = await getConversationPage(session, {
    limit: 40,
    after: page.messages.at(-1).id,
    version: page.version,
  });
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.messages, []);
});
