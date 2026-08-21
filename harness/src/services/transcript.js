// Shared helpers for reading Claude Code transcript .jsonl files. Used by the
// archive indexer (full-text) and by the chat view's resume-backfill (per-message
// history). NOTE: harness-spawned live sessions do NOT persist a transcript while
// running — these helpers only work on transcripts written by the user's own CLI
// runs (i.e. archived / resumed sessions).

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECTS_DIR = process.env.CVH_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

// Strip harness-injected wrappers (slash-command caveats, command metadata,
// system reminders) so a session that began with `/clear` reads cleanly.
// An attachment reaches Claude as the absolute path the composer swapped in for
// your `[label]` token, which is right for Claude and unreadable for a human —
// the phone's "your last prompt" pill showed the raw uploads path. Matches only
// this harness's own uploads naming (att-<epoch>-<n>.<ext>), quoted or bare, so
// a path you genuinely typed is left alone.
const ATTACHMENT_PATH_RE =
  /"[^"]*[\\/]uploads[\\/]att-\d+-\d+\.[a-z0-9]+"|\S*[\\/]uploads[\\/]att-\d+-\d+\.[a-z0-9]+/gi;

export function cleanPrompt(t) {
  return String(t)
    .replace(ATTACHMENT_PATH_RE, '[attachment]')
    .replace(/<local-command-[a-z]*>[\s\S]*?<\/local-command-[a-z]*>/gi, '')
    .replace(/<command-(name|message|args|contents)>[\s\S]*?<\/command-(name|message|args|contents)>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract human/assistant prose from a message.content (string OR block array).
// Only top-level `text` blocks — skips thinking / tool_use / tool_result / images.
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// A tool call rendered as one short line for the chat view's activity strip
// ("Read ChatView.jsx", "Bash: rebuild the desktop bundle"). Claude's `thinking`
// blocks reach the transcript with their text stripped — only a signature remains —
// so the tool calls are the only account of what a turn actually did.
const lastSegment = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const TOOL_ARG = {
  Read: (i) => lastSegment(i.file_path),
  Edit: (i) => lastSegment(i.file_path),
  Write: (i) => lastSegment(i.file_path),
  NotebookEdit: (i) => lastSegment(i.notebook_path),
  Bash: (i) => i.description || i.command,
  Grep: (i) => i.pattern,
  Glob: (i) => i.pattern,
  Task: (i) => i.description,
  Skill: (i) => i.skill,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
};
export function toolLabel(name, input) {
  const arg = String(TOOL_ARG[name]?.(input || {}) || '').replace(/\s+/g, ' ').trim();
  return arg ? `${name}: ${arg.slice(0, 140)}` : String(name || 'tool');
}

// Locate a transcript by Claude session uuid. Glob is robust to slug differences.
export function findTranscriptPath(uuid) {
  if (!uuid || !existsSync(PROJECTS_DIR)) return null;
  for (const d of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, d, uuid + '.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

// Parse a transcript into an ordered conversation: [{role:'user'|'assistant', text}].
// Cleaned user prompts + assistant text; skips sidechains, thinking, tool noise,
// and lines whose text is empty after cleaning. Capped for safety.
// `steps:true` additionally emits {role:'activity'} rows for each tool call, in
// order, so the chat view can show what a turn is doing while it runs. Off by
// default: the archive indexer and the resume backfill write these rows straight
// into the messages table, which only understands user/assistant.
export function parseMessages(filePath, { max = 2000, steps = false } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || out.length >= max) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.isSidechain || !o.message) return;
      // `isMeta` user rows are injected, not typed: the skill bodies Claude loads
      // mid-turn, the local-command caveat, and similar. They carry role "user"
      // and no toolUseResult, so without this they read as things YOU said — a
      // skill's preamble would surface as your last prompt.
      if (o.type === 'user' && o.message.role === 'user' && !o.toolUseResult && !o.isMeta) {
        const t = cleanPrompt(extractText(o.message.content));
        // Newer Claude Code stamps a genuine prompt with its origin; older
        // transcripts have neither field, so absence must not mean "not human".
        const human = o.origin ? o.origin.kind === 'human' : true;
        if (t) out.push({ role: 'user', text: t, ...(human ? {} : { injected: true }) });
      } else if (o.type === 'assistant') {
        // Blocks are walked in their original order so an activity row lands
        // between the text before it and the text after it.
        const content = o.message.content;
        if (steps && Array.isArray(content)) {
          for (const b of content) {
            if (!b) continue;
            if (b.type === 'text' && String(b.text || '').trim()) {
              out.push({ role: 'assistant', text: String(b.text).trim() });
            } else if (b.type === 'tool_use') {
              out.push({ role: 'activity', text: toolLabel(b.name, b.input) });
            }
          }
          return;
        }
        const t = extractText(content).trim();
        if (t) out.push({ role: 'assistant', text: t });
      }
    });
    rl.on('close', () => resolve(out));
    rl.on('error', reject);
  });
}

// Render a saved Claude JSONL conversation into plain terminal text so a resumed
// archive session opens with meaningful scrollback. This is intentionally a
// reconstructed conversation transcript, not the original PTY byte stream (Claude
// does not store raw terminal output in the JSONL archive).
export function renderTerminalTranscript(messages, { title = '', uuid = '', maxChars = 900_000 } = {}) {
  const lines = [
    '===== Resumed Claude conversation transcript =====',
    title ? `Title: ${title}` : '',
    uuid ? `Session: ${uuid}` : '',
    'Note: this is reconstructed from Claude Code\'s saved JSONL transcript; raw terminal bytes from the original process are not stored.',
    '===== Historical conversation starts below =====',
    '',
  ].filter(Boolean);
  let total = lines.join('\n').length;
  let clipped = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const who = m.role === 'user' ? 'USER' : 'CLAUDE';
    const block = [`----- ${who} ${i + 1} -----`, String(m.text || '').trim(), ''].join('\n');
    if (total + block.length > maxChars) {
      clipped = true;
      break;
    }
    lines.push(block);
    total += block.length;
  }
  if (clipped) {
    lines.push('', `[Transcript clipped at ${Math.round(maxChars / 1024)}KB to keep the mobile terminal responsive. Open Chat view for the full parsed conversation.]`);
  }
  lines.push('', '===== Live resumed terminal continues below =====', '');
  return lines.join('\n');
}
