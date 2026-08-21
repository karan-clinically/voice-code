// Detect and parse a Claude Code interactive selection prompt from a rendered
// screen.
//
// These are the numbered pickers Claude pauses on for a keyboard choice —
// AskUserQuestion, /model, /effort, plan approval, permission dialogs. They never
// fire the Stop hook (Claude is waiting, not finished), so the completion detector
// would otherwise scrape the raw box-drawing chrome and hand voice/chat garbage.
// Here we recognise the picker by its footer signature and pull out the question +
// numbered options as clean data the client can show, speak, and answer.

const FOOTER_RE = /esc to cancel/i; // the active selection footer (NOT "esc to interrupt", which is the working spinner)
const OPTION_RE = /^\s*[│┃]?\s*(❯|›|>|\*)?\s*(\d{1,2})\.\s+(.*?)(?:\s*[│┃])?\s*$/; // "│ ❯ 1. Label   description │"
const RULE_RE = /^[\s─—_-]{6,}$/; // horizontal rule
const CHROME_RE = /^[\s│┃╭╮╰╯─┌┐└┘├┤┬┴┼]*$/; // box borders / blank line

function cleanPromptLine(line) {
  return String(line || '')
    .replace(/^\s*[│┃]\s?/, '')
    .replace(/\s*[│┃]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitPromptProse(proseLines) {
  const prose = proseLines.join(' ').replace(/\s+/g, ' ').trim();
  if (!prose) return { question: '', context: '' };

  // Claude often puts an explanation above the actual question, separated by a
  // blank line. Work from the punctuation rather than the visual gap because a
  // narrow terminal wraps both paragraphs over several rows.
  const questionEnd = prose.lastIndexOf('?') + 1;
  if (questionEnd > 0) {
    const boundaryAt = Math.max(
      prose.lastIndexOf('.', questionEnd - 2),
      prose.lastIndexOf('!', questionEnd - 2),
      prose.lastIndexOf('?', questionEnd - 2),
    );
    const start = boundaryAt + 1;
    const question = prose.slice(start, questionEnd).trim();
    const context = (prose.slice(0, start) + ' ' + prose.slice(questionEnd))
      .replace(/\s+/g, ' ')
      .trim();
    return { question, context };
  }

  const question = proseLines.at(-1) || prose;
  return { question, context: proseLines.slice(0, -1).join(' ').trim() };
}

// Returns null when the screen isn't sitting on a picker, else
// { question, context, options:[{n,label,description,selected,cursor}], ... }.
export function detectPrompt(screen) {
  if (!screen) return null;
  const lines = screen.split('\n');

  // The active footer — search from the bottom so earlier chrome can't shadow it.
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footer = i; break; }
  }
  if (footer === -1) return null;

  // Numbered option lines above the footer.
  const options = [];
  let firstOpt = -1;
  for (let i = 0; i < footer; i++) {
    const m = lines[i].match(OPTION_RE);
    if (!m) continue;
    if (firstOpt === -1) firstOpt = i;
    const rest = m[3].replace(/[✔✓]\s*$/, '').trim();
    // Title is the text before the description column (a run of 2+ spaces) or a ·/— separator.
    const parts = rest.split(/\s{2,}|\s·\s|\s—\s/).map((part) => part.trim()).filter(Boolean);
    const label = parts.shift() || rest;
    options.push({
      n: Number(m[2]),
      label,
      description: parts.join(' '),
      selected: /✔|✓/.test(m[3]),
      cursor: !!m[1],
    });
  }
  if (options.length < 2) return null; // a lone "1." line isn't a picker

  // Keep the explanatory paragraph as well as the final question. Blank rows are
  // layout inside Claude's picker, not a reliable boundary between the two.
  const proseLines = [];
  for (let i = firstOpt - 1; i >= Math.max(0, firstOpt - 16); i--) {
    if (RULE_RE.test(lines[i])) { if (proseLines.length) break; else continue; }
    const t = cleanPromptLine(lines[i]);
    if (!t || CHROME_RE.test(lines[i]) || OPTION_RE.test(lines[i])) continue;
    if (/^(?:❯\s*\/|esc to |enter to |tab\/arrow|ctrl\+)/i.test(t)) continue;
    proseLines.unshift(t);
  }
  const { question, context: promptContext } = splitPromptProse(proseLines);

  const cursorN = (options.find((o) => o.cursor) || options.find((o) => o.selected) || options[0]).n;
  const pickerText = lines.slice(Math.max(0, firstOpt - 8), footer + 1).join('\n');
  const multi = /tab\/arrow|tab to (?:move|switch)|[☐◻▢]/i.test(pickerText);

  const p = { question, context: promptContext, options, cursorN, multi, hint: lines[footer].trim() };
  // `permission` separates "may I run this command" from a real question: the first
  // is spoken as its intent alone, the second gets a summary of Claude's findings
  // read out before it (see reply.js).
  return { ...p, permission: !!actionIntent(p), speech: promptSpeech(p), ask: promptAsk(p) };
}

// Which options a multi-select picker has to toggle to reach the wanted set, and
// how far the cursor moves to reach each. Claude's TUI has no "set" primitive —
// Space flips whatever the cursor is on — so answering means walking the list and
// flipping only the ones whose state differs from what was asked for. Ascending
// order keeps the walk one-directional and the cursor tracked between steps.
export function multiSelectPlan(prompt, indexes) {
  const want = new Set((indexes || []).map(Number));
  const steps = [];
  let cursor = prompt?.cursorN ?? 1;
  for (const option of [...(prompt?.options || [])].sort((a, b) => a.n - b.n)) {
    if (want.has(option.n) === !!option.selected) continue; // already as asked
    steps.push({ n: option.n, moves: option.n - cursor });
    cursor = option.n;
  }
  return steps;
}

// --- spoken form --------------------------------------------------------------
// What you HEAR is not what you read. A permission dialog's context is the command
// itself, and hearing "Bash command git push origin main --force-with-lease" read
// out is noise: you can't act on the flags, and the one thing you actually have to
// decide — yes or no — arrives last. Speech gets the intent instead ("Do you want
// to push these changes?"); the screen still shows the exact command.
const ACTION_INTENTS = [
  [/^edit\s+file/i, 'edit a file'],
  [/^(?:write|create)\s+file/i, 'write a new file'],
  [/^(?:web\s*fetch|fetch)\b/i, 'fetch a web page'],
];

const COMMAND_INTENTS = [
  [/^git\s+push/i, 'push these changes'],
  [/^git\s+(?:commit|add|stage)/i, 'commit these changes'],
  [/^git\s+(?:pull|fetch|clone)/i, 'pull the latest changes'],
  [/^git\s+(?:merge|rebase|cherry-pick)/i, 'merge some branches'],
  [/^git\s+(?:checkout|switch|branch|worktree)/i, 'switch branches'],
  [/^git\s+(?:reset|revert|restore|clean|stash)/i, 'undo some changes'],
  [/^gh\s+pr/i, 'open a pull request'],
  [/^gh\b/i, 'talk to GitHub'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b/i, 'install dependencies'],
  [/^(?:pytest|cargo\s+test|go\s+test)\b/i, 'run the tests'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^(?:jest|vitest)\b/i, 'run the tests'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^(?:vite|tsc)\s+build\b/i, 'build the project'],
  [/^(?:npm|pnpm|yarn|bun)\b/i, 'run a package script'],
  [/^(?:rm|del|rmdir|Remove-Item)\b/i, 'delete some files'],
  [/^(?:mv|move|cp|copy|mkdir|touch|Rename-Item)\b/i, 'move some files around'],
  [/^(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'make a network request'],
  [/^docker\b/i, 'run something in Docker'],
  [/^(?:ssh|scp|rsync)\b/i, 'connect to another machine'],
  [/^(?:kill|taskkill|pkill|Stop-Process)\b/i, 'stop a running process'],
  [/^(?:node|python3?|py|deno|npx|pwsh|powershell|bash|sh|make)\b/i, 'run a script'],
];

// '' when this isn't a "may I do X" dialog — then the question speaks for itself.
// Reads context and question as one run: a permission dialog has no sentence-ending
// punctuation before its question, so the splitter often leaves the whole thing —
// header, command and all — in `question`.
function actionIntent(p) {
  const raw = `${p.context || ''} ${p.question || ''}`.replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  for (const [re, intent] of ACTION_INTENTS) if (re.test(raw)) return intent;

  const command = raw.replace(/^bash\s*(?:command)?\s*[:(]?\s*/i, '').replace(/^["'`]/, '');
  const isCommand = command !== raw;
  for (const [re, intent] of COMMAND_INTENTS) if (re.test(command)) return intent;
  return isCommand ? 'run a command' : '';
}

// Permission options carry the command in their tail ("…don't ask again for git
// push commands in C:\…"), so they get trimmed back to the choice itself.
function shortOption(label) {
  return String(label || '')
    .replace(/\s+for\s+.*$/i, '')
    .replace(/,\s*and tell claude.*$/i, '')
    .replace(/\s*\(esc\)\s*$/i, '')
    .trim();
}

// Anything path-shaped, bracket-shaped or simply long is screen material, not
// something worth reading aloud before the question.
const CODEISH = /[{}<>|$`]|\/\/|\\\\|\S+\.(?:js|jsx|ts|tsx|mjs|py|json|md|css|sql|sh|ps1)\b/;

function speakableContext(context) {
  const c = String(context || '').replace(/\s+/g, ' ').trim();
  if (!c || c.length > 180 || CODEISH.test(c)) return '';
  return c;
}

// Just the decision: the question and its options, with no restatement of the
// on-screen context. Used when the spoken reply already summarized what Claude
// found, so the question lands at the end instead of the context being said twice.
export function promptAsk(p) {
  const options = p.options || [];
  const intent = actionIntent(p);
  if (intent) {
    const opts = options.map((o) => `${o.n}. ${shortOption(o.label)}`).filter((s) => s.length > 3).join('. ');
    const ask = `Claude wants to ${intent}. Do you want to allow it?`;
    return opts ? `${ask} Options: ${opts}.` : ask;
  }
  const q = String(p.question || '').trim() || 'Please choose how Claude should proceed.';
  const opts = options.map((o) => `${o.n}. ${o.label}${o.description ? `. ${o.description}` : ''}`).join('. ');
  return opts ? `Claude is asking: ${q}. Options: ${opts}.` : `Claude is asking: ${q}.`;
}

export function promptSpeech(p) {
  if (actionIntent(p)) return promptAsk(p);

  // Standalone form: nothing else is being read out, so the on-screen context has
  // to carry the background itself.
  const q = String(p.question || '').trim() || 'Please choose how Claude should proceed.';
  const context = speakableContext(p.context);
  if (!context) return promptAsk(p);
  const options = p.options || [];
  const intro = `Claude needs a decision. Here is the context: ${context}. The question is: ${q}.`;
  const opts = options.map((o) => `${o.n}. ${o.label}${o.description ? `. ${o.description}` : ''}`).join('. ');
  return opts ? `${intro} Options: ${opts}.` : intro;
}

// Speakable / displayable one-liner for the prompt — used as the recorded reply
// text and the TTS input so the question is never silently lost.
export function promptToText(p) {
  const q = p.question || 'Please choose an option.';
  const context = p.context ? `Context: ${p.context}\n\n` : '';
  const opts = p.options.map((o) => `${o.n}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('. ');
  return `${context}Claude is asking: ${q}\n\nOptions — ${opts}.`;
}

// Detect terminal states that are actionable but are not numbered prompts. Claude
// Code keeps foreground shell batches inside its spinner UI and offers Ctrl+B to
// detach them; without exposing that state, a remote/mobile session looks frozen.
// Failure detection is intentionally limited to the newest screen tail so an old
// error higher in scrollback cannot keep a stale warning alive forever.
export function detectTerminalActivity(screen) {
  if (!screen) return null;
  const tail = String(screen).split('\n').slice(-35).join('\n');
  const runningShell = /(?:running|searching[^\n]*running)\s+(?:\d+\s+)?shell\s+commands?/i.test(tail);
  if (runningShell) {
    const elapsed = tail.match(/\((?:(\d+)m\s*)?(\d+)s\s*[·)]/i);
    const duration = elapsed
      ? [elapsed[1] ? `${elapsed[1]}m` : '', `${elapsed[2]}s`].filter(Boolean).join(' ')
      : null;
    return {
      kind: 'foreground-shell',
      title: 'Shell commands are still running',
      detail: duration ? `Foreground command batch running for ${duration}.` : 'Foreground command batch is blocking this turn.',
      canBackground: true,
      canStop: true,
    };
  }

  const failure = tail.split('\n').reverse().find((line) =>
    /(?:shell|background|command).{0,80}(?:failed|timed out|exited with (?:code )?[1-9])|(?:failed|error).{0,80}(?:shell|background|command)/i.test(line)
  );
  if (failure) {
    return {
      kind: 'shell-failed',
      title: 'A shell command failed',
      detail: failure.trim().replace(/\s+/g, ' ').slice(0, 180),
      canBackground: false,
      canStop: true,
    };
  }
  return null;
}
