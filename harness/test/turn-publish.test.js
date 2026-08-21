// Every completed turn has to end up speakable — not just the ones a client asked
// for. A turn that finishes on its own (typed in the terminal, or an agent
// reporting back partway through a session) used to emit a 'turn' event and stop
// there, which only the desktop's active tab listens to; the phone had nothing to
// play. publishTurn records it like any other reply, and latestSpokenReply is how
// a polling client finds one it did not send.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CVH_DATA_DIR = mkdtempSync(join(tmpdir(), 'cvh-turn-'));
// getConfig falls back to env, so this is enough to make TTS "configured" and get
// a lazy audio url back without touching a provider.
process.env.ELEVENLABS_API_KEY = 'test-key';
process.env.ELEVENLABS_VOICE_ID = 'test-voice';

const db = (await import('../src/db.js')).default;
const { publishTurn, latestSpokenReply, spokenRepliesAfter, recordUserInteraction, spokenReply } = await import('../src/services/reply.js');

const newSession = (name) =>
  Number(
    db
      .prepare("INSERT INTO sessions (tmux_session, tmux_pane, label, cwd) VALUES (?, ?, ?, 'C:/tmp')")
      .run(name, name, name).lastInsertRowid
  );

test('an unsolicited turn is recorded as a reply with a lazy audio url', () => {
  const id = newSession('s1');
  const { interactionId, audioUrl } = publishTurn(id, 'the full assistant text', 'the spoken summary');

  assert.equal(audioUrl, `/api/tts/${interactionId}`);
  const row = db.prepare('SELECT * FROM interactions WHERE id = ?').get(interactionId);
  assert.equal(row.direction, 'claude');
  assert.equal(row.summary, 'the spoken summary');
  assert.equal(row.audio_path, null, 'synthesis stays lazy — nothing is billed until it is played');

  const latest = latestSpokenReply(id);
  assert.equal(latest.interactionId, interactionId);
  assert.equal(latest.audioUrl, audioUrl);
});

test('the newest reply wins, and rows with nothing to say are skipped', () => {
  const id = newSession('s2');
  publishTurn(id, 'first', 'first summary');
  const second = publishTurn(id, 'second', 'second summary').interactionId;
  recordUserInteraction(id, 'a user turn after it'); // no summary — not speakable
  publishTurn(id, 'unsummarizable', ''); // summary-less claude row — also skipped

  assert.equal(latestSpokenReply(id).interactionId, second);
});

test('a session that has not replied yet offers nothing to play', () => {
  const id = newSession('s3');
  recordUserInteraction(id, 'just asked something');
  assert.equal(latestSpokenReply(id), null);
});

test('replies stay scoped to their own session', () => {
  const a = newSession('s4');
  const b = newSession('s5');
  const mine = publishTurn(a, 'mine', 'my summary').interactionId;
  publishTurn(b, 'theirs', 'their summary');

  assert.equal(latestSpokenReply(a).interactionId, mine);
});

test('a client that fell behind gets every reply it missed, oldest first', () => {
  const id = newSession('s6');
  const seen = publishTurn(id, 'already heard', 'heard').interactionId;
  const a = publishTurn(id, 'agent one reporting', 'one').interactionId;
  const b = publishTurn(id, 'agent two reporting', 'two').interactionId;

  const missed = spokenRepliesAfter(id, seen);
  assert.deepEqual(missed.map((r) => r.interactionId), [a, b], 'in the order they were said');
  assert.equal(missed[0].audioUrl, `/api/tts/${a}`);
  assert.deepEqual(spokenRepliesAfter(id, b), [], 'nothing new once caught up');
});

test('falling a long way behind is capped, keeping the newest', () => {
  const id = newSession('s7');
  const ids = [];
  for (let i = 0; i < 9; i += 1) ids.push(publishTurn(id, `turn ${i}`, `summary ${i}`).interactionId);

  const caught = spokenRepliesAfter(id, 0, 4);
  assert.equal(caught.length, 4);
  assert.deepEqual(caught.map((r) => r.interactionId), ids.slice(-4), 'the four most recent, in order');
});

// --- how a turn that ended on a question is spoken -----------------------------
// Findings first, question last. Short findings are read as written (no model call,
// so these stay offline); long ones go through the summarizer, which is exercised
// by the prompt tests rather than billed here.

test('a question is spoken after the findings behind it, not instead of them', async () => {
  const spoken = await spokenReply({
    text: 'ignored — the prompt owns the wording',
    findings: 'I checked all four migrations. Two of them rewrite the invoices table.',
    prompt: {
      permission: false,
      speech: 'Claude needs a decision. Here is the context: two rewrite invoices. The question is: Deploy now?',
      ask: 'Claude is asking: Deploy now? Options: 1. Deploy. 2. Hold.',
    },
  });

  assert.match(spoken, /^I checked all four migrations/, 'the findings come first');
  assert.match(spoken, /Claude is asking: Deploy now\?\s*Options: 1\. Deploy\. 2\. Hold\.$/, 'the question comes last');
  assert.doesNotMatch(spoken, /Here is the context/, 'the context is not also restated');
});

test('a question with nothing behind it still gets asked on its own', async () => {
  const spoken = await spokenReply({
    text: 'x',
    findings: '',
    prompt: { permission: false, speech: 'Claude needs a decision. The question is: A or B?', ask: 'Claude is asking: A or B?' },
  });

  assert.equal(spoken, 'Claude needs a decision. The question is: A or B?');
});

test('a permission dialog stays the one-liner, findings or not', async () => {
  const spoken = await spokenReply({
    text: 'x',
    findings: 'I rewrote the summarizer and ran the tests, which all passed.',
    prompt: { permission: true, speech: 'Claude wants to push these changes. Do you want to allow it?', ask: 'same' },
  });

  assert.equal(spoken, 'Claude wants to push these changes. Do you want to allow it?');
});
