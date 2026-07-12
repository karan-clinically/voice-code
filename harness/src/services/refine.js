// Wispr-Flow-style dictation cleanup. Takes a raw speech transcript and rewrites
// it into a clean, well-structured instruction for Claude Code using a cheap LLM
// (gpt-4o-mini). Fail-open: any error returns the raw text unchanged.

import { getConfig } from '../config.js';
import { recordUsage } from './usage.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('refine');
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM = `You clean up dictated speech for a developer instructing a coding assistant (Claude Code).
Rewrite the user's raw voice transcript into a clear, concise, well-structured instruction.
- Remove filler words ("um", "uh", "like"), false starts, and repetition.
- Fix grammar, punctuation, and capitalization.
- Keep ALL technical terms, file names, paths, code, and the original intent exactly.
- Do NOT answer, execute, explain, or add anything the user did not say.
- If the transcript is already clean, return it essentially unchanged.
Output ONLY the cleaned instruction text, with no preamble or quotes.`;

export async function refineTranscript(text, { model } = {}) {
  const apiKey = getConfig('openai_api_key');
  const clean = (text || '').trim();
  if (!apiKey || !clean) return clean;

  const m = model || getConfig('cleanup_model', DEFAULT_MODEL);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: clean },
        ],
      }),
    });
    if (!r.ok) {
      const b = await r.text().catch(() => '');
      log.warn(`cleanup HTTP ${r.status}: ${b.slice(0, 200)}`);
      return clean;
    }
    const d = await r.json();
    if (d.usage) {
      recordUsage('openai', 'llm', 'openai_in_token', d.usage.prompt_tokens);
      recordUsage('openai', 'llm', 'openai_out_token', d.usage.completion_tokens);
    }
    const out = d.choices?.[0]?.message?.content?.trim();
    if (out) log.info(`cleaned ${clean.length} -> ${out.length} chars via ${m}`);
    return out || clean;
  } catch (e) {
    log.warn(`cleanup failed: ${e.message}`);
    return clean;
  }
}
