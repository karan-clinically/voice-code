import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sessionScreen, sessionMessagePage, sessionResize, termWsUrl, fsList, getSttMode, setSttMode, getSettings, saveSettings, listVoices, sayUrl } from './lib/api.js';
import { tapRecord, playUrl, voiceBoost, setVoiceBoost, VOICE_BOOST_LEVELS } from './lib/audio.js';
import { useDictation } from './lib/dictation.js';
import { THEMES, getTheme, applyTheme } from './lib/theme.js';
import { keepAwakeEnabled, setKeepAwake } from './lib/wakeLock.js';
import { readTerminalSnapshot, writeTerminalSnapshot } from './lib/localCache.js';
import { copyText } from './lib/clipboard.js';
import { listenForResume, watchReconnect } from './lib/resume.js';
import { mergeTail, promptText } from './lib/transcript.js';

export const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

// Older harness processes prefixed the real xterm screen with a stripped raw PTY
// log. Apart from duplicating output, that log exposed every intermediate TUI
// redraw (thinking/tool progress) as ordinary text. Keep the mobile client clean
// during rolling upgrades by retaining only the native screen after its marker.
const LEGACY_SCREEN_MARKER = '===== Current terminal screen =====';
function nativeTerminalHtml(html) {
  const value = String(html || '');
  const markerAt = value.lastIndexOf(LEGACY_SCREEN_MARKER);
  return markerAt < 0 ? value : value.slice(markerAt + LEGACY_SCREEN_MARKER.length).replace(/^\r?\n/, '');
}

function terminalLineText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
}

// Codex renders submitted prompts as a `›` line followed by two-space-indented
// wraps. Its own replies use `•`, but both inherit the same terminal foreground
// colour. Add semantic markup without disturbing Codex's ANSI formatting so each
// app theme can apply its established user accent (`--term-user`).
function highlightCodexUserTurns(html) {
  let inUserTurn = false;
  return String(html || '').split('\n').map((line) => {
    const text = terminalLineText(line);
    const startsUserTurn = /^\s*›\s+\S/.test(text);
    if (startsUserTurn) {
      const prompt = text.replace(/^\s*›\s+/, '').trim();
      // Codex's empty-composer suggestion is UI chrome, not user-authored text.
      inUserTurn = !/^find and fix a bug in @filename$/i.test(prompt);
    } else if (inUserTurn) {
      if (!text.trim()) inUserTurn = false;
      else if (!/^\s{2,}\S/.test(text)) inUserTurn = false;
    }
    return inUserTurn ? `<span class="terminal-user-turn">${line}</span>` : line;
  }).join('\n');
}

const escapeTerminalHtml = (value) => String(value || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const TERMINAL_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TERMINAL_URL_TRAILING_RE = /[.,;:!?\]\)}]+$/;
function linkifyTerminalText(value) {
  const text = String(value || '');
  let html = '';
  let offset = 0;
  for (const match of text.matchAll(TERMINAL_URL_RE)) {
    const raw = match[0];
    const trailing = raw.match(TERMINAL_URL_TRAILING_RE)?.[0] || '';
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    if (!url) continue;
    html += escapeTerminalHtml(text.slice(offset, match.index));
    const href = escapeTerminalHtml(url).replace(/"/g, '&quot;');
    html += `<a class="terminal-link" href="${href}" target="_blank" rel="noopener noreferrer">${escapeTerminalHtml(url)}</a>`
      + `<button type="button" class="terminal-link-copy" data-copy="${href}" title="Copy link" aria-label="Copy link"></button>`
      + escapeTerminalHtml(trailing);
    offset = match.index + raw.length;
  }
  return html + escapeTerminalHtml(text.slice(offset));
}

const TERMINAL_CODE_RE = /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g;
const escapeTerminalAttr = (value) => escapeTerminalHtml(value).replace(/"/g, '&quot;');
function copyableTerminalText(value) {
  const text = String(value || '');
  let html = '';
  let offset = 0;
  for (const match of text.matchAll(TERMINAL_CODE_RE)) {
    html += linkifyTerminalText(text.slice(offset, match.index));
    const code = (match[1] ?? match[2] ?? '').replace(/\n$/, '');
    const block = match[1] != null;
    html += `<button type="button" class="terminal-copy-code${block ? ' block' : ''}" data-copy="${escapeTerminalAttr(code)}" title="Tap to copy">${escapeTerminalHtml(code)}</button>`;
    offset = match.index + match[0].length;
  }
  return html + linkifyTerminalText(text.slice(offset));
}

// The live TUI hard-wraps at the pane's column count, so a long URL arrives split
// across physical lines: only its first piece linkifies, and tapping or copying it
// yields a truncated address. Rejoin the pieces. A URL ending exactly at the end of
// a FULL line was cut by the wrap, so the run of URL-legal characters opening the
// next line belongs to it. Visible text stays as the terminal drew it; the href and
// the copy value are made whole, and each continuation run becomes part of the link
// so tapping any piece opens the same address.
const URL_TAIL_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

function terminalTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: full.length });
    full += node.nodeValue || '';
  }
  return { nodes, full };
}

function joinWrappedTerminalLinks(root) {
  for (const anchor of [...root.querySelectorAll('a.terminal-link')]) {
    // Rebuilt per anchor: splitting a text node below invalidates earlier offsets.
    const { nodes, full } = terminalTextMap(root);
    // Terminal output is padded to the pane width, so the longest line IS the wrap
    // column. With no full-width line there is nothing to tell a wrap apart from a
    // URL that merely ended a sentence, so those are left alone.
    const lines = full.split('\n');
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    // One long line proves nothing — it is its own maximum. Two lines reaching the
    // same column is the wrap column, which a terminal always supplies (box borders,
    // rules, the input frame). Without that corroboration, leave the link alone.
    if (width < 20 || lines.filter((line) => line.length >= width).length < 2) break;

    const own = [...anchor.childNodes].filter((n) => n.nodeType === 3).pop();
    const entry = own && nodes.find((e) => e.node === own);
    if (!entry) continue;

    const runs = [];
    let cursor = entry.start + (own.nodeValue || '').length;
    while (cursor < full.length && runs.length < 6) {
      const lineStart = full.lastIndexOf('\n', cursor - 1) + 1;
      if (cursor !== full.indexOf('\n', cursor)) break; // not flush with the wrap
      if (cursor - lineStart < width - 1) break; // the line had room to spare
      const nextEnd = full.indexOf('\n', cursor + 1);
      const line = full.slice(cursor + 1, nextEnd < 0 ? full.length : nextEnd);
      const indent = line.length - line.replace(/^\s+/, '').length;
      const run = line.slice(indent).match(URL_TAIL_RE)?.[0];
      if (!run) break;
      runs.push({ start: cursor + 1 + indent, length: run.length, text: run });
      if (indent + run.length !== line.length) break; // prose resumed on this line
      cursor = cursor + 1 + line.length;
    }
    if (!runs.length) continue;

    const href = anchor.href + runs.map((r) => r.text).join('');
    anchor.href = href;
    const button = anchor.nextElementSibling;
    if (button?.classList.contains('terminal-link-copy')) button.dataset.copy = href;
    // Dress each continuation as part of the link, so it reads as one address and
    // tapping the tail opens the same page as tapping the head.
    for (const run of runs) {
      const { nodes: fresh } = terminalTextMap(root);
      const host = fresh.find((e) => e.start <= run.start && run.start + run.length <= e.start + (e.node.nodeValue || '').length);
      if (!host) continue;
      const tail = host.node.splitText(run.start - host.start);
      tail.splitText(run.length);
      const piece = document.createElement('a');
      piece.className = 'terminal-link';
      piece.href = href;
      piece.target = '_blank';
      piece.rel = 'noopener noreferrer';
      piece.textContent = tail.nodeValue;
      tail.replaceWith(piece);
    }
  }
}

// Rolling upgrades may leave the phone on a newer client while the harness process
// still serves pre-linkified terminal HTML. Linkify text nodes at render time too;
// existing anchors are skipped, so this is safe once the server-side renderer has
// also been restarted. Working at the DOM level avoids ever touching span/style
// markup with a URL regex.
function linkifyTerminalHtml(value) {
  const template = document.createElement('template');
  template.innerHTML = String(value || '');
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest('a, .terminal-copy-code') || !/https?:\/\//i.test(node.nodeValue || '')) continue;
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(TERMINAL_URL_RE)) {
      const raw = match[0];
      const trailing = raw.match(TERMINAL_URL_TRAILING_RE)?.[0] || '';
      const url = trailing ? raw.slice(0, -trailing.length) : raw;
      if (!url) continue;
      fragment.append(document.createTextNode(text.slice(offset, match.index)));
      const anchor = document.createElement('a');
      anchor.className = 'terminal-link';
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = url;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'terminal-link-copy';
      copy.dataset.copy = url;
      copy.title = 'Copy link';
      copy.setAttribute('aria-label', 'Copy link');
      // No text node: the glyph comes from CSS, so selecting the line to copy it
      // by hand never drags the icon into the clipboard along with the URL.
      fragment.append(anchor, copy, document.createTextNode(trailing));
      offset = match.index + raw.length;
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  joinWrappedTerminalLinks(template.content);
  return foldTerminalTools(copyableLiveTerminalCommands(template.innerHTML));
}

// Claude's live TUI removes Markdown fences before the rendered terminal reaches
// the phone. Recover the useful semantic for standalone CLI lines. Keep this list
// deliberately command-shaped so ordinary prose does not become a copy target.
const LIVE_COMMAND_RE = /^(?:php\s+artisan|(?:npm|pnpm|yarn|bun)\s+|npx\s+|git\s+|docker(?:\s+compose)?\s+|composer\s+|(?:python3?|node|deno)\s+|(?:curl|wget)\s+|(?:pwsh|powershell)\s+|dotnet\s+|cargo\s+|go\s+|kubectl\s+|terraform\s+|\.\.?[\\/]|[A-Za-z]:[\\/])/i;
const COMMAND_FLAG_CONTINUATION_RE = /^(?:--[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?)(?:\s+--[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?)*$/;
function terminalHtmlLineText(line) {
  const holder = document.createElement('div');
  holder.innerHTML = line;
  return (holder.textContent || '').trim();
}
function copyableLiveTerminalCommands(html) {
  const lines = String(html || '').split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = terminalHtmlLineText(line);
    if (!text || /terminal-copy-code|<a\b/i.test(line) || !LIVE_COMMAND_RE.test(text)) {
      result.push(line);
      continue;
    }
    const visual = [line];
    const command = [text];
    while (i + 1 < lines.length) {
      const nextText = terminalHtmlLineText(lines[i + 1]);
      if (!COMMAND_FLAG_CONTINUATION_RE.test(nextText)) break;
      i += 1;
      visual.push(lines[i]);
      command.push(nextText);
    }
    const copyValue = command.join(' ');
    result.push(`<button type="button" class="terminal-copy-code block" data-copy="${escapeTerminalAttr(copyValue)}" title="Tap to copy">${visual.join('\n')}</button>`);
  }
  return result.join('\n');
}
// A tool call in Claude Code's TUI opens with a bullet, the tool's name and its
// arguments in parentheses -- "● Bash(cd ... && cat ...)" -- and its result follows
// on ⎿-prefixed lines. The model's own prose carries the same bullet but never the
// Name( form, which is what tells the two apart. Codex marks its tool output with
// the same result glyph and the same "+N lines" fold hint.
const TOOL_HEAD_RE = /^\s*[●•▪◆]?\s*\*{0,2}[A-Z][A-Za-z0-9_.-]{1,24}\*{0,2}\(/;
const TOOL_RESULT_RE = /^\s*[⎿└├]/;
const TOOL_FOLD_RE = /\(ctrl\+o to expand\)|^\s*…\s*\+\d+ lines/m;
// Stable enough to survive a repaint, which is all an open/closed flag needs.
function toolKey(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

// Only tool calls get a container; every other line is emitted exactly as it
// arrived, newlines and all, so the flow of the output is untouched.
const TERMINAL_CHROME_RE = /^\s*[\u2500-\u257f\u2580-\u259f]/;
const TERMINAL_RULE_RE = /^[\s\u2500-\u257f\u2580-\u259f=_~]*$/;

// Split the top level into rendered lines. A text node can span several, so it is cut
// at each newline; an element that itself spans lines (a multi-line command button)
// stays whole and ends the line it sits on.
function terminalLines(root) {
  const lines = [[]];
  for (const node of [...root.childNodes]) {
    node.remove();
    if (node.nodeType === 3) {
      const parts = (node.nodeValue || '').split('\n');
      parts.forEach((part, i) => {
        if (i) lines.push([]);
        if (part) lines[lines.length - 1].push(document.createTextNode(part));
      });
      continue;
    }
    lines[lines.length - 1].push(node);
    if ((node.textContent || '').includes('\n')) lines.push([]);
  }
  return lines;
}

function foldTerminalTools(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const lines = terminalLines(template.content);
  const out = document.createDocumentFragment();
  let run = [];
  let blanks = 0; // blank lines banked since the last thing emitted
  let last = 'none'; // 'none' | 'plain' | 'fold'

  // Blank lines are counted rather than written as they arrive, because a fold is a
  // block element and the browser treats the newlines around one asymmetrically: the
  // newline before it is absorbed into the block's own break, the one after it is
  // not. Deciding the count at emit time keeps the terminal's own spacing on both
  // sides — a run of plain lines comes back byte-identical.
  const separate = () => {
    const count = (last === 'plain' ? 1 : 0) + blanks;
    if (last !== 'none' && count > 0) out.append(document.createTextNode('\n'.repeat(count)));
    blanks = 0;
  };
  const emitPlain = (line) => {
    separate();
    line.forEach((node) => out.append(node));
    last = 'plain';
  };
  const emitFold = (box) => {
    separate();
    out.append(box);
    last = 'fold';
  };

  const flush = () => {
    if (!run.length) return;
    const texts = run.map((line) => line.map((node) => node.textContent || '').join(''));
    const body = texts.join('\n');
    // Tool calls and their output are the bulk of a session and almost never what
    // you scrolled back to read. Fold each one behind a single-line summary so the
    // model's own words are what the eye lands on. Everything else is left alone.
    if (!(TOOL_HEAD_RE.test(texts[0]) || texts.some((t) => TOOL_RESULT_RE.test(t)) || TOOL_FOLD_RE.test(body))) {
      run.forEach(emitPlain);
      run = [];
      return;
    }
    const resultAt = texts.findIndex((t) => TOOL_RESULT_RE.test(t));
    const head = (resultAt > 0 ? texts.slice(0, resultAt) : texts).join(' ')
      .replace(/^\s*[●•▪◆]\s*/, '').replace(/\s+/g, ' ').trim();
    const box = document.createElement('div');
    box.className = 'tool-block';
    box.dataset.key = toolKey(body);
    const summary = document.createElement('div');
    summary.className = 'tool-summary';
    summary.setAttribute('role', 'button');
    summary.tabIndex = 0;
    summary.title = 'Tap to expand';
    // Split so an OPEN fold can shrink back to just the tool's name: the arguments
    // are the first thing the body itself shows, and repeating them reads as a bug.
    const name = head.match(/^([A-Za-z0-9_.-]{1,24})\(/)?.[1] || head.slice(0, 28);
    const rest = head.slice(name.length);
    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = name;
    const argsEl = document.createElement('span');
    argsEl.className = 'tool-args';
    argsEl.textContent = rest.length > 64 ? rest.slice(0, 63) + '…' : rest;
    const count = document.createElement('span');
    count.className = 'tool-lines';
    count.textContent = texts.length + (texts.length === 1 ? ' line' : ' lines');
    summary.append(nameEl, argsEl, count);
    const full = document.createElement('div');
    full.className = 'tool-full';
    run.forEach((line, i) => {
      if (i) full.append(document.createTextNode('\n'));
      line.forEach((node) => full.append(node));
    });
    box.append(summary, full);
    emitFold(box);
    run = [];
  };

  for (const line of lines) {
    const text = line.map((node) => node.textContent || '').join('');
    // A blank line or the CLI's own frame ends a run: neither belongs inside a fold.
    if (!text.trim()) {
      flush();
      blanks += 1;
    } else if (TERMINAL_CHROME_RE.test(text) || TERMINAL_RULE_RE.test(text)) {
      flush();
      emitPlain(line);
    } else {
      run.push(line);
    }
  }
  flush();
  // The newest tool is usually the one still running: leave that one open, so a long
  // command is not hidden behind a summary while you are waiting on it.
  const tools = out.querySelectorAll('.tool-block');
  if (tools.length) tools[tools.length - 1].dataset.live = '1';
  template.content.replaceChildren(out);
  return template.innerHTML;
}

const comparableTerminalText = (value) => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity])
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function completedTurnsHtml(messages, terminalHtml) {
  const visible = comparableTerminalText(terminalHtml);
  return (messages || [])
    .filter((message) => {
      const text = comparableTerminalText(message?.text);
      if (!text) return false;
      // Only suppress a completed turn when the WHOLE normalized message remains
      // in xterm. As soon as a new query starts, Claude's TUI often replaces the
      // preceding answer with a shortened first/last fragment. Treating either
      // fragment as a full match made that previous answer visibly "compress".
      // Keeping the durable transcript copy is preferable to a little overlap at
      // the live-screen boundary: terminal history must never lose answer text.
      return !visible.includes(text);
    })
    .map((message) => {
      const label = message.role === 'user' ? 'You' : 'Claude';
      const body = message.role === 'user' ? linkifyTerminalText(message.text) : copyableTerminalText(message.text);
      const turn = `<strong class="terminal-transcript-label">${label}:</strong>\n${body}`;
      return message.role === 'user' ? `<span class="terminal-transcript-user">${turn}</span>` : turn;
    })
    .join('\n\n');
}

function messageFragmentVisible(message, terminalHtml) {
  const text = comparableTerminalText(message?.text);
  const visible = comparableTerminalText(terminalHtml);
  if (!text || !visible) return false;
  if (visible.includes(text)) return true;
  const anchorLength = Math.min(64, text.length);
  const step = Math.max(16, Math.floor(anchorLength / 2));
  for (let start = 0; start + anchorLength <= text.length; start += step) {
    if (visible.includes(text.slice(start, start + anchorLength))) return true;
  }
  return text.length > anchorLength && visible.includes(text.slice(-anchorLength));
}

// Dictation mic bound to a text box: the transcript lands in `text` for review
// and is NEVER sent — the caller's Send/Run button is the only way to the pty.
// In stream mode the words appear live while speaking.
export function DictationMic({ className, text, setText, notify }) {
  const { recording, tidying, toggle } = useDictation({ text, setText, notify });
  return (
    <button
      type="button"
      className={(className || 'micbtn') + (recording ? ' rec' : '') + (tidying ? ' tidying' : '')}
      onClick={toggle}
      disabled={tidying}
      title={recording ? 'Tap to stop' : tidying ? 'Tidying up what you said…' : 'Tap to talk'}
    >
      {tidying ? '✨' : '🎙️'}
    </button>
  );
}

// Quick batch|stream toggle. Shared with the desktop (persisted harness-side).
export function SttModeToggle({ notify }) {
  const [mode, setMode] = useState('batch');
  useEffect(() => {
    getSttMode().then(setMode).catch(() => {});
  }, []);
  const choose = async (m) => {
    const prev = mode;
    setMode(m); // optimistic
    try {
      await setSttMode(m);
    } catch (e) {
      setMode(prev);
      notify?.(e.message);
    }
  };
  return (
    <div className="seg" title="How voice reaches the box — nothing sends until you tap Send">
      <button className={'seg-btn' + (mode !== 'stream' ? ' on' : '')} onClick={() => choose('batch')}>
        Batch
      </button>
      <button className={'seg-btn' + (mode === 'stream' ? ' on' : '')} onClick={() => choose('stream')}>
        Live
      </button>
    </div>
  );
}

// Summarise dictation: off = light cleanup (near-verbatim), on = condense
// rambling speech into a tight instruction (keeps file names/paths/code). Shared
// harness-side via /api/settings, so it applies to phone + desktop dictation.
export function SummariseToggle({ notify }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    getSettings().then((s) => setOn(s.dictation_summarise === 'on')).catch(() => {});
  }, []);
  const choose = async (want) => {
    if (want === on) return;
    setOn(want); // optimistic
    try {
      await saveSettings({ dictation_summarise: want ? 'on' : 'off' });
    } catch (e) {
      setOn(!want);
      notify?.(e.message);
    }
  };
  return (
    <div className="seg" title="How much your speech is rewritten before it lands in the box">
      <button className={'seg-btn' + (!on ? ' on' : '')} onClick={() => choose(false)}>Clean up</button>
      <button className={'seg-btn' + (on ? ' on' : '')} onClick={() => choose(true)}>Summarise</button>
    </div>
  );
}

// Per-device toggle for holding the screen awake while awaiting spoken replies or
// during a hands-free voice session.
// localStorage-backed (like the theme), since it's about this phone's screen, not a
// shared harness pref.
export function KeepAwakeToggle() {
  const [on, setOn] = useState(keepAwakeEnabled);
  const choose = (want) => { setKeepAwake(want); setOn(want); };
  return (
    <div className="seg" title="Keep the screen on while waiting for spoken replies">
      <button className={'seg-btn' + (!on ? ' on' : '')} onClick={() => choose(false)}>Off</button>
      <button className={'seg-btn' + (on ? ' on' : '')} onClick={() => choose(true)}>On</button>
    </div>
  );
}

// How far to lift spoken replies above whatever else is playing. Android mixes a
// transient sound in rather than ducking the music app, and a web page cannot
// turn that app down — so this is the only lever over intelligibility in a car.
export function VoiceBoostPicker() {
  const [id, setId] = useState(() => voiceBoost().id);
  const choose = (next) => { setVoiceBoost(next); setId(next); };
  return (
    <div className="seg" title="Lift Claude's voice above music playing from another app">
      {VOICE_BOOST_LEVELS.map((level) => (
        <button
          key={level.id}
          className={'seg-btn' + (id === level.id ? ' on' : '')}
          onClick={() => choose(level.id)}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}

// ElevenLabs voice picker. Voice is the only speech choice now — Deepgram was
// dropped (its Aura-2 renders at ~1x realtime, too slow for hands-free). On load
// it also pins the provider to ElevenLabs so nothing can drift back to Deepgram.
// The API key never reaches the phone; it only sees voice names/ids.
// Which engine speaks, and in which voice. Replaces a picker that quietly wrote
// `tts_provider: 'elevenlabs'` on every open — a lock from when Deepgram was
// pulled from the UI, which meant no other engine could ever stay selected.
//
// Engines differ in what they cost and what they offer, so the choice is yours to
// make rather than one the app makes for you: ElevenLabs is the most expressive
// and by far the priciest; Speechmatics is roughly a tenth the price with four
// English voices; Deepgram comes free with the key that already does dictation.
// Only engines with a key configured are offered — the key itself never leaves
// the PC, so this reads a boolean, not a secret.
const ENGINES = [
  { id: 'elevenlabs', name: 'ElevenLabs', voiceKey: 'elevenlabs_voice_id', note: 'Most voices · priciest' },
  { id: 'speechmatics', name: 'Speechmatics', voiceKey: 'speechmatics_voice_id', note: '4 English voices · cheapest' },
  { id: 'deepgram', name: 'Deepgram', voiceKey: 'deepgram_tts_voice', note: 'Same key as dictation' },
];

export function SpeechEnginePicker({ notify }) {
  const [settings, setSettings] = useState(null);
  const [engine, setEngine] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const spec = ENGINES.find((e) => e.id === engine);
  const available = ENGINES.filter((e) => settings?.[`${e.id}_available`]);

  useEffect(() => {
    let stop = false;
    getSettings()
      .then((s) => {
        if (stop) return;
        setSettings(s);
        // Whatever is configured server-side wins — the UI reports the truth
        // rather than imposing a default the way the old picker did.
        const active = ENGINES.find((e) => e.id === s.tts_provider && s[`${e.id}_available`]);
        const fallback = ENGINES.find((e) => s[`${e.id}_available`]);
        setEngine((active || fallback)?.id || '');
      })
      .catch((e) => notify?.(e.message));
    return () => { stop = true; };
  }, []);

  // Voices belong to an engine, so they are re-fetched whenever it changes.
  useEffect(() => {
    if (!engine || !settings) return undefined;
    let stop = false;
    setLoadingVoices(true);
    setVoiceId(settings[ENGINES.find((e) => e.id === engine).voiceKey] || '');
    listVoices(engine)
      .then((d) => { if (!stop) setVoices(d.voices || []); })
      .catch((e) => { if (!stop) notify?.(e.message); })
      .finally(() => { if (!stop) setLoadingVoices(false); });
    return () => { stop = true; };
  }, [engine, settings]);

  const chooseEngine = async (id) => {
    const previous = engine;
    setEngine(id); // optimistic — the voice list follows from this
    try {
      await saveSettings({ tts_provider: id });
    } catch (e) {
      setEngine(previous);
      notify?.(e.message);
    }
  };

  const chooseVoice = async (id) => {
    const previous = voiceId;
    setVoiceId(id);
    try {
      await saveSettings({ [spec.voiceKey]: id });
    } catch (e) {
      setVoiceId(previous);
      notify?.(e.message);
    }
  };

  const preview = async () => {
    if (!voiceId || previewing) return;
    setPreviewing(true);
    // The engine is already saved, so /say renders through the one just picked.
    await playUrl(sayUrl('Hi, this is how I sound reading your replies.', voiceId), {
      onError: (why) => notify?.('No speech: ' + why),
    });
    setPreviewing(false);
  };

  if (!settings) return <div className="muted">Loading speech settings…</div>;
  if (!available.length) {
    return <div className="muted">Add a TTS API key on the PC to choose an engine.</div>;
  }

  const hasCurrent = voices.some((v) => v.voice_id === voiceId);
  return (
    <div className="stack">
      <div className="engine-picker" role="radiogroup" aria-label="Speech engine">
        {available.map((e) => (
          <button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={engine === e.id}
            className={'engine-option' + (engine === e.id ? ' on' : '')}
            onClick={() => chooseEngine(e.id)}
          >
            <span className="engine-name">{e.name}</span>
            <span className="engine-note">{e.note}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <select value={voiceId} onChange={(ev) => chooseVoice(ev.target.value)} disabled={loadingVoices} style={{ flex: 1 }} aria-label="Voice">
          {loadingVoices && <option value="">Loading voices…</option>}
          {!loadingVoices && voices.length === 0 && <option value="">No voices found</option>}
          {!loadingVoices && voiceId && !hasCurrent && <option value={voiceId}>Current voice</option>}
          {voices.map((v) => (
            <option key={v.voice_id} value={v.voice_id}>
              {v.name}{v.category ? ` · ${v.category}` : ''}
            </option>
          ))}
        </select>
        <button type="button" onClick={preview} disabled={!voiceId || previewing} title="Hear this voice" style={{ flex: '0 0 auto' }}>
          {previewing ? '▶…' : '▶ Preview'}
        </button>
      </div>
      {ENGINES.some((e) => !settings[`${e.id}_available`]) && (
        <div className="muted" style={{ fontSize: 12 }}>
          No key on the PC for: {ENGINES.filter((e) => !settings[`${e.id}_available`]).map((e) => e.name).join(', ')}.
        </div>
      )}
    </div>
  );
}

export function ThemePicker() {
  const [theme, setTheme] = useState(getTheme);
  const choose = (id) => setTheme(applyTheme(id));
  return (
    <div className="theme-grid">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          className={'theme-card' + (t.id === theme ? ' on' : '')}
          onClick={() => choose(t.id)}
          aria-pressed={t.id === theme}
        >
          <span className="theme-sw" style={{ background: t.bg, borderColor: t.border }}>
            <span className="theme-sw-dot" style={{ background: t.accent }} />
            <span className="theme-sw-bar" style={{ background: t.accent }} />
            <span className="theme-sw-line" style={{ background: t.text }} />
            <span className="theme-sw-line short" style={{ background: t.muted }} />
          </span>
          <span className="theme-meta">
            <span className="theme-name">{t.name}{t.id === theme && <span className="theme-check">✓</span>}</span>
            <span className="theme-tag">{t.tag}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// Tap-to-talk mic. onBlob(blob, ext) receives the recording; caller decides what
// to do (transcribe, or send as a command).
export function MicButton({ className, onBlob, notify }) {
  const [rec, setRec] = useState(null);
  async function toggle() {
    if (rec) {
      rec.stop();
      setRec(null);
      return;
    }
    const h = await tapRecord(
      (blob, ext) => {
        setRec(null);
        onBlob(blob, ext);
      },
      notify
    );
    if (h) setRec(h);
  }
  return (
    <button type="button" className={(className || 'micbtn') + (rec ? ' rec' : '')} onClick={toggle} title="Tap to talk">
      🎙️
    </button>
  );
}

// Colored terminal view: polls the session's rendered HTML and injects it,
// keeping scroll pinned to the bottom unless the user scrolled up. Resizes the
// session's PTY to the phone's width so the TUI reflows to fit — full lines are
// visible at a readable, user-adjustable font (A−/A+, persisted), no sideways scroll.
// How close to the bottom (px) still counts as "following the tail". Shared by
// the repaint gate and the reviewing lock — they MUST agree: a tighter reviewing
// threshold once left a dead band (at-bottom per paint, reviewing per the lock)
// where fractional mobile scrollTop settled after a touch and live repaints
// froze permanently until a pixel-perfect scroll to the bottom.
const FOLLOW_TAIL_PX = 60;

export function Terminal({ sessionId, className, promptPending = false, sessionKind = '', inputSignal = 0, onUserTurns }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const reviewingRef = useRef(false);
  // Which tool blocks the reader has explicitly opened or closed. The pane rebuilds
  // its whole innerHTML on every repaint, so the flag cannot live in the DOM; a block
  // with no entry falls back to its default (open only if it is the newest one).
  const openToolsRef = useRef(new Map());
  const restoreOpenTools = (inner) => {
    for (const box of inner.querySelectorAll('.tool-block')) {
      const chosen = openToolsRef.current.get(box.dataset.key);
      box.classList.toggle('open', chosen === undefined ? box.dataset.live === '1' : chosen);
    }
  };
  const forcePaintRef = useRef(null);
  const promptPendingRef = useRef(promptPending);
  useEffect(() => { promptPendingRef.current = promptPending; }, [promptPending]);
  // Read through a ref: the socket/paint effect keys on sessionId alone, so a
  // callback captured directly would go stale on the first re-render.
  const onUserTurnsRef = useRef(onUserTurns);
  useEffect(() => { onUserTurnsRef.current = onUserTurns; }, [onUserTurns]);
  const [displayState, setDisplayState] = useState('loading'); // loading | cached | live
  const [unreachable, setUnreachable] = useState(false); // live refresh keeps failing
  const [connectionState, setConnectionState] = useState('connecting'); // connecting | live | reconnecting
  const [showReconnect, setShowReconnect] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The session's PTY is gone (server sent {t:'exit'}). Shown as a banner over the
  // stale screen instead of freezing silently; cleared the moment data flows again
  // (a resumed conversation re-adopts the same db row, so it CAN come back).
  const [ended, setEnded] = useState(false);
  const endedRef = useRef(false);
  useEffect(() => { endedRef.current = ended; }, [ended]);
  const [fontPx, setFontPx] = useState(() => {
    const v = parseInt(localStorage.getItem('cvh_term_font') || '', 10);
    return v >= 8 && v <= 22 ? v : 13;
  });

  useEffect(() => {
    localStorage.setItem('cvh_term_font', String(fontPx));
  }, [fontPx]);

  // Fit the PTY to the box: measure the monospace cell at the current font, derive
  // cols/rows, and resize the session so Claude renders exactly this wide. Only
  // POST when the size actually changes; the harness skips resizes while a command
  // is running (a SIGWINCH would cancel /compact), so we retry until it applies.
  const lastFit = useRef({ cols: 0, rows: 0 });
  const fitPty = useCallback(async () => {
    const outer = outerRef.current;
    if (!outer || !outer.clientWidth) return;
    // Don't resize while the user is typing — opening the phone keyboard resizes
    // the viewport, and the resulting SIGWINCH cancels the slash-command menu (or
    // any open prompt) the user is building. The initial fit runs before focus.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${getComputedStyle(outer).fontFamily};font-size:${fontPx}px`;
    probe.textContent = 'X'.repeat(40);
    document.body.appendChild(probe);
    // getBoundingClientRect reports VISUAL pixels and clientWidth reports LAYOUT
    // pixels. Those are the same number until the phone-fit scale is on (see
    // lib/view.js), and then the ratio between them is the scale — measure it off
    // the box itself rather than reading the scale, so this stays a no-op without
    // it. Mixing the two collapsed the terminal to its 20-column floor.
    const outerRect = outer.getBoundingClientRect();
    const scale = outerRect.width / outer.clientWidth || 1;
    const charW = probe.getBoundingClientRect().width / 40 / scale;
    probe.remove();
    if (!charW) return;
    const cols = Math.max(20, Math.min(120, Math.floor((outer.clientWidth - 20) / charW)));
    const rows = Math.max(12, Math.min(60, Math.floor((outer.clientHeight - 20) / (fontPx * 1.3))));
    // Only resize on a real WIDTH (cols) change. Opening/closing the phone keyboard
    // changes height (rows) only — resizing for that fires a SIGWINCH that cancels
    // the slash-command menu or a modal right as you send. Skip height-only changes.
    if (lastFit.current.cols === cols) return;
    try {
      const r = await sessionResize(sessionId, cols, rows);
      if (r && !r.skipped) lastFit.current = { cols, rows }; // lock in only if actually applied
    } catch {
      /* offline / route not deployed yet */
    }
  }, [sessionId, fontPx]);

  useEffect(() => {
    const t = setTimeout(fitPty, 200); // one fit after open; then only on width change
    let rt;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(fitPty, 300); };
    window.addEventListener('resize', onResize); // rotation (a real width change) re-fits
    return () => { clearTimeout(t); clearTimeout(rt); window.removeEventListener('resize', onResize); };
  }, [fitPty]);

  // Normal resume handshakes complete in a few hundred milliseconds. Avoid
  // flashing a scary reconnect banner for those; retain it for a genuine delay.
  useEffect(() => {
    if (displayState !== 'live' || connectionState === 'live' || ended) {
      setShowReconnect(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowReconnect(true), 1500);
    return () => clearTimeout(timer);
  }, [displayState, connectionState, ended]);

  // Push, not poll. /ws/term streams every PTY byte the instant it lands, so use it
  // as a change signal and repaint straight away instead of waiting out a timer. The
  // in-flight guard makes this self-throttling: during a burst we repaint as fast as
  // the server can render the screen and coalesce everything else into one trailing
  // repaint, so fast-scrolling output costs no more than the old interval did. The
  // slow interval stays purely as a backstop for whatever the socket misses (a
  // dropped connection, a redraw with no new bytes).
  useEffect(() => {
    let stop = false;
    let busy = false;
    let busySince = 0;
    let paintFailures = 0; // consecutive; the chip stops claiming "updating" after a few
    let again = false;
    let repaintTimer = null;
    let lastPaintStarted = 0;
    let cacheTimer = null;
    let forcePaintUntil = 0;
    let queuedCacheHtml = '';
    const queueSnapshot = (html) => {
      queuedCacheHtml = html;
      if (cacheTimer) return;
      cacheTimer = setTimeout(() => {
        cacheTimer = null;
        const snapshot = queuedCacheHtml;
        queuedCacheHtml = '';
        if (snapshot) writeTerminalSnapshot(sessionId, snapshot);
      }, 750);
    };
    // Paint the last bounded snapshot immediately. The live request below runs in
    // parallel and silently replaces it when the harness responds.
    readTerminalSnapshot(sessionId).then((cached) => {
      if (stop || !cached?.html) return;
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner || inner.dataset.h) return;
      const cachedHtml = linkifyTerminalHtml(cached.html);
      inner.innerHTML = cachedHtml;
      restoreOpenTools(inner);
      inner.dataset.h = cachedHtml;
      outer.scrollTop = outer.scrollHeight;
      setDisplayState('cached');
    });
    let latestScreen = null;
    let olderTerminalHtml = '';
    let transcriptMessages = [];
    let transcriptBefore = null;
    let transcriptHasOlder = false;
    let transcriptFetchedAt = 0;
    let transcriptSignature = '';
    let transcriptVersion = null; // server's transcript stamp; unchanged = skip the body
    const refreshTranscript = async () => {
      const now = Date.now();
      if (now - transcriptFetchedAt < 5000) return false;
      transcriptFetchedAt = now;
      try {
        // Once we hold the page, ask only for the tail. A full snapshot of a
        // long-running session is most of a megabyte, and re-pulling it every few
        // seconds is what used to saturate the link the terminal socket shares.
        const held = transcriptMessages.length ? transcriptMessages[transcriptMessages.length - 1].id : null;
        const page = await sessionMessagePage(sessionId, {
          limit: 40,
          after: held,
          version: transcriptVersion,
        });
        transcriptVersion = page.version || null;
        if (page.unchanged) return false;
        const nextMessages = page.delta ? mergeTail(transcriptMessages, page.messages || []) : (page.messages || []);
        const nextSignature = nextMessages
          .map((message) => `${message.id}:${message.role}:${message.text?.length || 0}:${message.text?.slice(-64) || ''}`)
          .join('|');
        const changed = nextSignature !== transcriptSignature;
        transcriptSignature = nextSignature;
        transcriptMessages = nextMessages;
        // Everything YOU said, oldest first. Free here — this poll already holds
        // the conversation — and it stays right whether a prompt came from this
        // phone, the desktop or a terminal driving the same session. `injected`
        // marks content the CLI wrote as a user turn (skill bodies, caveats).
        const yours = nextMessages
          .filter((message) => message.role === 'user' && !message.injected && message.text)
          .map((message) => promptText(message.text))
          .filter(Boolean); // an attachment-only turn has no words of yours in it
        if (yours.length) onUserTurnsRef.current?.(yours);
        // A delta says nothing about the top of the window, so the paging cursor
        // this client already holds stays as it is.
        if (!page.delta) {
          transcriptBefore = page.before;
          transcriptHasOlder = !!page.hasOlder;
        }
        return changed;
      } catch {
        /* shell/Codex sessions may not have completed conversation turns */
        return false;
      }
    };
    const composedHtml = () => {
      const rawTerminalHtml = [olderTerminalHtml, nativeTerminalHtml(latestScreen?.html)].filter(Boolean).join('\n');
      const terminalHtml = sessionKind === 'codex' ? highlightCodexUserTurns(rawTerminalHtml) : rawTerminalHtml;
      // Claude's TUI can use an alternate screen with no xterm scrollback. Once
      // genuine terminal pages are exhausted, completed turns provide clean long
      // history without raw thinking/tool redraws or synthetic section banners.
      const terminalHistoryExhausted = latestScreen && (!latestScreen.hasOlder || latestScreen.hasTerminalPrelude);
      const latestMessage = transcriptMessages[transcriptMessages.length - 1];
      const settledAnswerOnScreen = !promptPendingRef.current
        && latestMessage?.role !== 'user'
        && messageFragmentVisible(latestMessage, terminalHtml);
      // A settled answer can be much taller than Claude's TUI viewport. If any
      // fragment of it is on-screen, the transcript is the authoritative complete
      // rendering; combining it with the viewport would either duplicate or cut it.
      if (terminalHistoryExhausted && settledAnswerOnScreen) {
        return completedTurnsHtml(transcriptMessages, '');
      }
      const completedHtml = terminalHistoryExhausted ? completedTurnsHtml(transcriptMessages, terminalHtml) : '';
      return [completedHtml, terminalHtml].filter(Boolean).join('\n\n');
    };
    const replaceRendered = ({ preserveTop = false, preservePosition = false } = {}) => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const renderedHtml = linkifyTerminalHtml(composedHtml());
      if (inner.dataset.h === renderedHtml) return;
      const oldHeight = outer.scrollHeight;
      const oldTop = outer.scrollTop;
      const sx = outer.scrollLeft;
      inner.innerHTML = renderedHtml;
      restoreOpenTools(inner);
      inner.dataset.h = renderedHtml;
      outer.scrollLeft = sx;
      outer.scrollTop = preservePosition
        ? oldTop
        : preserveTop
          ? oldTop + (outer.scrollHeight - oldHeight)
          : outer.scrollHeight;
      queueSnapshot(renderedHtml);
    };

    let pagingOlder = false;
    const loadOlder = async () => {
      const outer = outerRef.current;
      if (stop || pagingOlder || !outer || outer.scrollTop > 140) return;
      // A pre-upgrade server reports its synthetic raw log as a terminal prelude.
      // Never page into that log; after restart this flag is false and native xterm
      // history pages normally.
      const canPageTerminal = !latestScreen?.hasTerminalPrelude && latestScreen?.hasOlder && latestScreen.startLine > 0;
      const canPageTranscript = !canPageTerminal && transcriptHasOlder && transcriptBefore != null;
      if (!canPageTerminal && !canPageTranscript) return;
      pagingOlder = true;
      setLoadingOlder(true);
      try {
        if (canPageTerminal) {
          const page = await sessionScreen(sessionId, { before: latestScreen.startLine, lines: 400 });
          olderTerminalHtml = [page.html || '', olderTerminalHtml].filter(Boolean).join('\n');
          latestScreen = {
            ...latestScreen,
            startLine: page.startLine,
            hasOlder: !!page.hasOlder,
          };
        } else {
          const page = await sessionMessagePage(sessionId, { before: transcriptBefore, limit: 40 });
          transcriptMessages = [...(page.messages || []), ...transcriptMessages];
          transcriptBefore = page.before;
          transcriptHasOlder = !!page.hasOlder;
        }
        replaceRendered({ preserveTop: true });
      } catch {
        /* leave the current page readable; a later upward scroll can retry */
      } finally {
        pagingOlder = false;
        if (!stop) setLoadingOlder(false);
      }
    };
    const onHistoryScroll = () => {
      const outer = outerRef.current;
      if (outer && outer.scrollTop < 140) loadOlder();
    };
    outerRef.current?.addEventListener('scroll', onHistoryScroll, { passive: true });

    const paint = async () => {
      if (stop) return;
      // Every request in here is timed, so a guard held this long is wedged, not
      // working — release it rather than wait on a visibility flip to do it.
      if (busy && Date.now() - busySince > 20000) busy = false;
      if (busy) { again = true; return; }
      // Direct keypad input is latency-sensitive: bypass the normal burst throttle
      // during its short force window so cursor movement feels immediate.
      const forcedInputPaint = Date.now() < forcePaintUntil;
      const delay = forcedInputPaint ? 0 : 300 - (Date.now() - lastPaintStarted);
      if (delay > 0) {
        again = true;
        if (!repaintTimer) {
          repaintTimer = setTimeout(() => {
            repaintTimer = null;
            again = false;
            paint();
          }, delay);
        }
        return;
      }
      busy = true;
      busySince = Date.now();
      lastPaintStarted = busySince;
      try {
        const [screen, transcriptChanged] = await Promise.all([
          sessionScreen(sessionId),
          refreshTranscript(),
        ]);
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (outer && inner) {
          const atBottom = outer.scrollHeight - outer.scrollTop - outer.clientHeight < FOLLOW_TAIL_PX;
          // Replacing the entire rendered screen while a finger/wheel is moving
          // interrupts momentum scrolling on mobile browsers and can snap the user
          // away from the oldest output. Freeze the snapshot while history is being
          // read; the next socket event/backstop poll catches up at the bottom.
          const forcePaint = Date.now() < forcePaintUntil;
          if ((atBottom && !reviewingRef.current) || forcePaint) {
            latestScreen = screen;
            olderTerminalHtml = '';
            replaceRendered();
          } else if (transcriptChanged) {
            // Completed transcript turns can grow after the final PTY redraw. Do
            // not freeze that durable history just because the user touched or
            // scrolled the terminal; update it without moving their viewport.
            replaceRendered({ preservePosition: true });
          }
        }
        paintFailures = 0;
        setUnreachable(false);
        setDisplayState('live');
      } catch (err) {
        // The pty is gone. Same fact the terminal socket reports with {t:'exit'},
        // but this path still arrives when that socket is the thing that's wedged.
        // Anything else here is transient and the next poll retries — but say so
        // once it keeps happening, instead of an "updating…" that never lands.
        if (err?.ended || err?.status === 409 || /no live PTY/i.test(err?.message || '')) setEnded(true);
        else if (++paintFailures >= 3) setUnreachable(true);
      }
      busy = false;
      if (again && !stop) { again = false; paint(); }
    };

    // Keypad input must behave like a real terminal even when opening the keypad
    // changed the viewport and made `atBottom` false. Arm a short force window, but
    // do not fetch yet: the PTY has not processed the key at this point. Its data
    // event below starts the paint once the updated cursor/menu actually exists.
    // Fetching here used to capture the old screen and then require a second network
    // round trip, which made arrows and Enter feel markedly laggy on a phone.
    forcePaintRef.current = () => {
      reviewingRef.current = false;
      forcePaintUntil = Date.now() + 900;
    };

    // The push socket. Locking the phone suspends the tab: the OS kills this socket
    // (no more 'data' events) and can freeze an in-flight paint's fetch so `busy`
    // never clears. Auto-reconnect on close, and — critically — treat the visibility
    // flip as the recovery trigger: clear the stuck guard, rewire the socket, repaint.
    //
    // Two failure modes need more than onclose:
    //  - ZOMBIE socket: a connection that died without a FIN (Wi-Fi→cellular handoff,
    //    harness host vanished) stays readyState OPEN forever and onclose never fires.
    //    The app-level ping/pong below detects it: no pong within the deadline →
    //    force-close → the normal onclose reconnect takes over.
    //  - PTY gone: the server answers a connect for a dead session with {t:'exit'}.
    //    Reconnecting at full speed just loops exit→close, so back off and surface it
    //    (setEnded) — but keep probing, because a resumed conversation re-adopts the
    //    SAME db row and this terminal must come back to life when it does.
    let ws = null;
    let pongDue = null; // timer armed per ping; fires = no pong in time = zombie
    let reconnectTimer = null;
    let connectDeadline = null;
    let connectingSince = 0; // when the current handshake started (watchdog below)
    const retrySoon = () => {
      if (stop || document.hidden || reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 500);
    };
    const connect = () => {
      if (stop || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        setConnectionState('connecting');
        const socket = new WebSocket(termWsUrl(sessionId));
        ws = socket;
        connectingSince = Date.now();
        connectDeadline = setTimeout(() => {
          if (ws !== socket || socket.readyState === WebSocket.OPEN) return;
          // Chrome/WebKit can leave a post-suspend handshake in CONNECTING forever,
          // with neither error nor close. Detach it and start a clean attempt.
          ws = null;
          try { socket.close(); } catch { /* stuck handshake */ }
          setConnectionState('reconnecting');
          retrySoon();
        }, 4000);
        socket.onopen = () => {
          if (ws !== socket) return;
          clearTimeout(connectDeadline); connectDeadline = null;
          setConnectionState('live');
        };
        socket.onmessage = (e) => {
          if (ws !== socket) return;
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'data') { setEnded(false); paint(); }
          else if (m.t === 'pong') { clearTimeout(pongDue); pongDue = null; }
          else if (m.t === 'exit') { setEnded(true); }
        };
        socket.onerror = () => {
          if (ws === socket) try { socket.close(); } catch { /* onclose/deadline retries */ }
        };
        socket.onclose = () => {
          if (ws !== socket) return;
          ws = null;
          clearTimeout(connectDeadline); connectDeadline = null;
          clearTimeout(pongDue); pongDue = null;
          if (!stop) setConnectionState('reconnecting');
          if (!stop && !document.hidden && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, endedRef.current ? 5000 : 1500);
          }
        };
      } catch {
        // The backstop poll keeps the view useful; retry without stacking timers.
        ws = null;
        retrySoon();
      }
    };
    const pinger = setInterval(() => {
      if (stop || document.hidden || !ws || ws.readyState !== 1 || pongDue) return;
      try { ws.send(JSON.stringify({ t: 'ping' })); } catch { return; }
      const pingedSocket = ws;
      pongDue = setTimeout(() => {
        pongDue = null;
        if (ws === pingedSocket) try { pingedSocket.close(); } catch { /* dead */ }
      }, 8000);
    }, 20000);
    const onVisible = () => {
      if (stop || document.hidden) return;
      busy = false; again = false; // unwedge a paint frozen by suspend
      // A mobile network handoff commonly leaves a dead socket reporting OPEN.
      // Do not wait up to 28s for ping/pong detection after an explicit resume.
      const stale = ws;
      ws = null;
      clearTimeout(pongDue); pongDue = null;
      clearTimeout(connectDeadline); connectDeadline = null;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      try { stale?.close(); } catch { /* already dead */ }
      connect();
      paint(); // force an immediate catch-up repaint on resume
    };
    const stopResume = listenForResume(onVisible);

    // Every reconnect above is armed by an event (onclose, the connect deadline,
    // the resume flip) and two of them decline to arm anything while the page
    // reports hidden — which a phone does intermittently as it wakes. Lose the
    // last one that way and the terminal waits on a visibility change that will
    // never come, showing "Reconnecting…" until a manual reload. So re-check the
    // invariant on a timer instead: no socket, a closed one, or a handshake that
    // has been in flight too long (the 4s deadline is itself a timer, and timers
    // freeze with the tab) means connect again.
    const stopWatchdog = watchReconnect(() => {
      if (stop || reconnectTimer) return;
      const healthy = ws && (ws.readyState === WebSocket.OPEN
        || (ws.readyState === WebSocket.CONNECTING && Date.now() - connectingSince < 8000));
      if (healthy) return; // a live socket that silently died is the pinger's job
      if (ws) {
        const abandoned = ws;
        ws = null;
        try { abandoned.close(); } catch { /* stuck handshake */ }
      }
      connect();
    });

    connect();
    paint();
    const t = setInterval(paint, 2000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(pinger);
      stopWatchdog();
      clearTimeout(pongDue);
      clearTimeout(connectDeadline);
      clearTimeout(reconnectTimer);
      clearTimeout(repaintTimer);
      clearTimeout(cacheTimer);
      outerRef.current?.removeEventListener('scroll', onHistoryScroll);
      if (queuedCacheHtml) writeTerminalSnapshot(sessionId, queuedCacheHtml);
      stopResume();
      try { ws?.close(); } catch { /* already gone */ }
      if (forcePaintRef.current) forcePaintRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (inputSignal > 0) forcePaintRef.current?.();
  }, [inputSignal]);

  const bump = (d) => setFontPx((f) => Math.max(8, Math.min(22, f + d)));
  const updateReviewing = () => {
    const outer = outerRef.current;
    if (outer) reviewingRef.current = outer.scrollHeight - outer.scrollTop - outer.clientHeight > FOLLOW_TAIL_PX;
  };
  const copyTerminalCommand = async (event) => {
    // The summary line is the fold's handle, so a tap there opens or closes rather
    // than copying. The body underneath still copies, the same as any other block.
    const summary = event.target.closest?.('.tool-summary');
    if (summary && outerRef.current?.contains(summary)) {
      const box = summary.parentElement;
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      openToolsRef.current.set(box.dataset.key, open);
      return;
    }
    // Copy targets are deliberately narrow: a link, or a command. Prose is read, not
    // copied, and making every paragraph a button turned ordinary taps into copies.
    const button = event.target.closest?.('.terminal-copy-code, .terminal-link-copy');
    if (!button || !outerRef.current?.contains(button)) return;
    event.preventDefault(); // a link-copy tap must not also follow the adjacent anchor
    const copied = await copyText(button.dataset.copy || button.textContent || '');
    if (!copied) return;
    button.dataset.copied = 'Copied';
    setTimeout(() => { if (button.isConnected) delete button.dataset.copied; }, 1200);
  };

  return (
    <div className={'term-wrap ' + (className || '')}>
      {/* A session whose pty is gone will never paint again, so neither spinner
          below is telling the truth — the "session ended" banner is. Without this
          the screen poll kept failing, kept retrying, and left "Loading terminal…"
          or "Saved view · updating…" up for good. */}
      {displayState === 'loading' && !ended && (
        <div className="term-load-backdrop">
          <div className="term-load-modal" role="status" aria-live="polite">
            <span className="load-spinner" />
            <span>Loading terminal…</span>
          </div>
        </div>
      )}
      {displayState === 'cached' && !ended && (
        // Cached output is real content the user can read RIGHT NOW — never dim
        // or block it behind a modal while the live refresh happens. A small
        // pill (same spot as the reconnect status; the two states are mutually
        // exclusive) is enough to signal freshness.
        <div className="term-reconnect-status" role="status" aria-live="polite">
          <span className="load-spinner" /> {unreachable ? 'Saved view · harness not answering, retrying…' : 'Saved view · updating…'}
        </div>
      )}
      {showReconnect && (
        <div className="term-reconnect-status" role="status" aria-live="polite">
          <span className="load-spinner" /> Reconnecting live terminal…
        </div>
      )}
      {ended && (
        <div className="term-ended" role="status">
          Session ended — the screen below is its last output. Go back to Sessions to resume.
        </div>
      )}
      {loadingOlder && (
        <div className="term-history-status" role="status">
          <span className="load-spinner" /> Loading earlier output…
        </div>
      )}
      <div className="term-fontctl">
        <button onClick={() => bump(-1)} aria-label="Smaller font">A−</button>
        <button onClick={() => bump(1)} aria-label="Larger font">A+</button>
      </div>
      <div
        ref={outerRef}
        className="screen"
        onPointerDown={() => { reviewingRef.current = true; }}
        onPointerUp={updateReviewing}
        onPointerCancel={updateReviewing}
        onWheel={() => { reviewingRef.current = true; }}
        onScroll={updateReviewing}
        onClick={copyTerminalCommand}
      >
        <div ref={innerRef} className="screen-inner" style={{ fontSize: fontPx + 'px' }} />
      </div>
    </div>
  );
}

// Full-screen folder browser over the PC's filesystem.
// "＋" on a folder heading: another session in THAT folder, so the common case
// (a second agent on the project you're already in) skips the path box entirely.
// Shared by the Home list and the in-session switcher, which show the same
// folder headings and would otherwise each grow their own copy.
export function NewInFolderButton({ cwd, providers = [], onStart, starting = false }) {
  const [open, setOpen] = useState(false);
  const choices = providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }];
  const folder = basename(cwd);
  return (
    <>
      <button
        className="cc-folder-add"
        title={`New session in ${folder}`}
        aria-label={`New session in ${folder}`}
        onClick={(e) => {
          e.stopPropagation(); // the heading itself may be tappable
          setOpen(true);
        }}
      >
        ＋
      </button>
      {open && (
        <div className="pm-sheet on-top" onClick={(e) => e.stopPropagation()}>
          <div className="pm-sheet-head">
            <div className="sv-title">New session in {folder}</div>
            <button className="ghost" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="pm-sheet-list">
            <div className="card stack">
              <h2>Which CLI?</h2>
              {choices.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => {
                    setOpen(false);
                    onStart(provider, cwd);
                  }}
                  disabled={starting}
                >
                  {provider.name}
                </button>
              ))}
              <p className="muted" style={{ margin: 0 }}>{cwd}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function FolderPicker({ start, onPick, onClose, notify }) {
  const [cur, setCur] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);

  const load = async (path) => {
    try {
      const d = await fsList(path || '');
      setCur(d.path);
      setParent(d.parent);
      setDirs(d.dirs || []);
    } catch (e) {
      if (path) load('');
      else notify(e.message);
    }
  };
  useEffect(() => {
    load(start || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="picker">
      <div className="picker-head">
        <button className="ghost" onClick={() => parent && load(parent)}>⬆ Up</button>
        <div className="pkpath">{cur || 'This PC'}</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="pklist">
        {dirs.length === 0 && <div className="muted" style={{ padding: 14 }}>(no subfolders — tap “Use this folder”)</div>}
        {dirs.map((d) => (
          <button key={d.path} className="pkitem" onClick={() => load(d.path)}>
            📁&nbsp;&nbsp;{d.name}
          </button>
        ))}
      </div>
      <div className="picker-foot">{cur && <button className="primary" onClick={() => onPick(cur)}>Use this folder</button>}</div>
    </div>
  );
}
