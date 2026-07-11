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
export function cleanPrompt(t) {
  return String(t)
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
export function parseMessages(filePath, { max = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || out.length >= max) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.isSidechain || !o.message) return;
      if (o.type === 'user' && o.message.role === 'user' && !o.toolUseResult) {
        const t = cleanPrompt(extractText(o.message.content));
        if (t) out.push({ role: 'user', text: t });
      } else if (o.type === 'assistant') {
        const t = extractText(o.message.content).trim();
        if (t) out.push({ role: 'assistant', text: t });
      }
    });
    rl.on('close', () => resolve(out));
    rl.on('error', reject);
  });
}
