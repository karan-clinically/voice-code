import test from 'node:test';
import assert from 'node:assert/strict';
import pkg from '@xterm/headless';
import { renderLines } from '../src/services/terminal.js';

const { Terminal } = pkg;

// Render `text` through a terminal of the given width and return the HTML lines.
async function render(text, cols = 40) {
  const term = new Terminal({ cols, rows: 10, allowProposedApi: true });
  await new Promise((done) => term.write(text, done));
  return renderLines(term, 0, term.buffer.active.length);
}

const hrefs = (html) => [...html.matchAll(/<a class="terminal-link" href="([^"]+)"/g)].map((m) => m[1]);

test('a URL hard-wrapped across lines links to the whole url on every piece', async () => {
  const url = 'https://treehousepc.tail176244.ts.net:10444/some/deep/path?q=1';
  const lines = await render(`see ${url} ok\r\n`);
  const wrapped = lines.filter((l) => l.includes('terminal-link'));
  assert.equal(wrapped.length, 2, 'the url should be split across two physical lines');
  for (const line of wrapped) {
    for (const href of hrefs(line)) assert.equal(href, url);
  }
  // Both halves of the visible text survive, and the trailing word is not swallowed.
  assert.match(wrapped[0], /treehousepc/);
  assert.match(wrapped[1], /deep/);
  assert.match(lines.join('\n'), / ok/);
});

test('the copy affordance is emitted once, after the end of the url', async () => {
  const url = 'https://example.test/a/b';
  const lines = await render(`go ${url} now\r\n`, 80);
  const html = lines.join('\n');
  const copies = [...html.matchAll(/class="terminal-link-copy" data-copy="([^"]+)"/g)];
  assert.equal(copies.length, 1);
  assert.equal(copies[0][1], url);
});

test('trailing punctuation stays outside the link', async () => {
  const lines = await render('see https://example.test/x.\r\n', 80);
  const html = lines.join('\n');
  assert.equal(hrefs(html)[0], 'https://example.test/x');
  // The period follows the link (and its copy button) as plain text.
  assert.match(html, /<\/button>\./);
  assert.doesNotMatch(html, /x\.<\/a>/);
});

test('plain text renders without links and stays escaped', async () => {
  const lines = await render('a < b & c > d\r\n', 80);
  const html = lines.join('\n');
  assert.doesNotMatch(html, /terminal-link/);
  assert.match(html, /a &lt; b &amp; c &gt; d/);
});
