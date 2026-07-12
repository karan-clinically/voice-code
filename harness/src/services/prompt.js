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
const OPTION_RE = /^\s*(❯|›|>|\*)?\s*(\d{1,2})\.\s+(.*\S)\s*$/; // "❯ 1. Label   description"
const RULE_RE = /^[\s─—_-]{6,}$/; // horizontal rule
const CHROME_RE = /^[\s│┃╭╮╰╯─┌┐└┘├┤┬┴┼]*$/; // box borders / blank line

// Returns null when the screen isn't sitting on a picker, else
// { question, options:[{n,label,selected,cursor}], cursorN, multi, hint }.
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
    const rest = m[3];
    // Title is the text before the description column (a run of 2+ spaces) or a ·/— separator.
    const label = rest.split(/\s{2,}|\s·\s|\s—\s/)[0].replace(/[✔✓]\s*$/, '').trim();
    options.push({ n: Number(m[2]), label, selected: /✔|✓/.test(rest), cursor: !!m[1] });
  }
  if (options.length < 2) return null; // a lone "1." line isn't a picker

  // Question: the nearest text lines above the first option, up to a rule/blank gap.
  const qlines = [];
  for (let i = firstOpt - 1; i >= 0; i--) {
    if (RULE_RE.test(lines[i])) break;
    const t = lines[i].trim();
    if (!t || CHROME_RE.test(lines[i])) { if (qlines.length) break; else continue; }
    if (OPTION_RE.test(lines[i])) break;
    if (/^\s*❯\s*\//.test(lines[i])) continue; // the "❯ /model" command echo
    qlines.unshift(t);
    if (qlines.length >= 3) break;
  }
  const question = qlines.join(' ').replace(/\s+/g, ' ').trim();

  const cursorN = (options.find((o) => o.cursor) || options.find((o) => o.selected) || options[0]).n;
  const context = lines.slice(Math.max(0, firstOpt - 5), footer + 1).join('\n');
  const multi = /tab\/arrow|tab to (?:move|switch)|[☐◻▢]/i.test(context);

  return { question, options, cursorN, multi, hint: lines[footer].trim() };
}

// Speakable / displayable one-liner for the prompt — used as the recorded reply
// text and the TTS input so the question is never silently lost.
export function promptToText(p) {
  const q = p.question || 'Please choose an option.';
  const opts = p.options.map((o) => `${o.n}. ${o.label}`).join('. ');
  return `Claude is asking: ${q}\n\nOptions — ${opts}.`;
}
