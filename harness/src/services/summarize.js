// Spoken-reply summarizer.
//
// Claude's replies are routinely far longer than anyone wants read aloud. The
// previous implementation did NOT summarize despite its name — it truncated:
// under 600 chars it read the text verbatim, and over that it spoke only the
// first paragraph, then "…", then the last one, silently dropping the entire
// middle. So the listener never heard the substance of a long answer.
//
// Now: short replies are still read verbatim (nothing to gain from a round-trip),
// and long ones are rewritten into spoken prose that condenses the WHOLE reply —
// middle included. When the reply asks a question or needs a decision, the summary
// leads with that and reads out every option, because that's the one case where the
// listener has to act and can't glance at the screen to recover what was missed.
//
// Fail-open at every step: no OpenAI key, or any API error, falls back to the old
// condense-by-truncation so speech never breaks outright.

import { getConfig } from '../config.js';
import { recordUsage } from './usage.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('summarize');
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
// Speech is the ONLY channel here — a clumsy sentence can't be re-read, so this is
// worth more than the cheapest tier. gpt-4o-mini produced stilted prose and buried
// the question when Claude needed a decision. Override with the `summary_model`
// config if the spend matters more than the wording.
const DEFAULT_MODEL = 'gpt-4o';

// Below this, just read it — it is already a sentence or two.
const SPEAK_VERBATIM_MAX = 600;

const SYSTEM = `You turn a coding assistant's written reply into natural spoken words for a developer who is away from their screen (often driving). They can ONLY listen — they cannot see anything, and they cannot re-read you.

Sound like a sharp colleague talking, not like a document being read out:
- Plain spoken prose. Contractions are good. Full sentences.
- Never speak markdown, symbols, backticks, code, or URLs.
- Don't read out long file paths — name the thing ("the summarizer", "the sessions route"), not the path.
- Summarize the ENTIRE reply, middle included. Never just the opening and the ending.

MOST IMPORTANT — if the reply asks a question, offers choices, or needs a decision:
- Say that FIRST and unmistakably. Open with "Claude needs a decision." or "Claude is asking."
- State the question in one clear sentence.
- Then read out every choice as a spoken option: "Option one, ... Option two, ..." — never omit or merge the options, and never bury them at the end.
- Say what you'd need to answer, so they can reply out loud.

Otherwise:
- Lead with the outcome — what was done, what was found, or what changed.
- Then only the details that actually matter to them.

Keep it as short as it can be while still being useful — usually 2 to 5 sentences.
State only what the reply says. Add nothing, invent nothing, guess nothing.
Output only the spoken text.`;

// Markdown -> speakable plain text.
export function toPlainSpeech(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, (m) => {
    const n = Math.max(1, m.split('\n').length - 2);
    return ` (a code block of ${n} lines) `;
  });
  t = t.replace(/`([^`]+)`/g, '$1'); // inline code
  t = t.replace(/^#{1,6}\s+/gm, ''); // headings
  t = t.replace(/^\s*[-*+]\s+/gm, ''); // bullets
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1'); // emphasis
  return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// Last-resort shortener when no model is available. This is the old behaviour,
// kept only as a fallback — it drops the middle, which is why it is not the
// primary path any more.
function condense(t, maxChars) {
  if (t.length <= maxChars) return t;
  const paras = t.split('\n').map((s) => s.trim()).filter(Boolean);
  if (paras.length > 2) {
    const combined = `${paras[0]} … ${paras[paras.length - 1]}`;
    if (combined.length <= maxChars) return combined;
  }
  return `${t.slice(0, maxChars - 1).trim()}…`;
}

export async function summarizeForSpeech(text, { model } = {}) {
  const plain = toPlainSpeech(text);
  if (!plain) return '';
  if (plain.length <= SPEAK_VERBATIM_MAX) return plain;

  const apiKey = getConfig('openai_api_key');
  if (!apiKey) {
    log.debug('no OpenAI key — falling back to truncation for speech');
    return condense(plain, SPEAK_VERBATIM_MAX);
  }

  const m = model || getConfig('summary_model', DEFAULT_MODEL);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: plain },
        ],
      }),
    });
    if (!r.ok) {
      const b = await r.text().catch(() => '');
      log.warn(`summary HTTP ${r.status}: ${b.slice(0, 200)}`);
      return condense(plain, SPEAK_VERBATIM_MAX);
    }
    const d = await r.json();
    if (d.usage) {
      recordUsage('openai', 'llm', 'openai_in_token', d.usage.prompt_tokens);
      recordUsage('openai', 'llm', 'openai_out_token', d.usage.completion_tokens);
    }
    const out = d.choices?.[0]?.message?.content?.trim();
    if (!out) return condense(plain, SPEAK_VERBATIM_MAX);
    log.info(`spoken summary: ${plain.length} -> ${out.length} chars via ${m}`);
    return out;
  } catch (e) {
    log.warn(`summary failed: ${e.message}`);
    return condense(plain, SPEAK_VERBATIM_MAX);
  }
}
