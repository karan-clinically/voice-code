// Resolves the Managed Agents agent + environment this app drives sessions with.
//
// Preferred: pin ANTHROPIC_AGENT_ID / ANTHROPIC_ENVIRONMENT_ID in Vercel env
// vars (GET /api/setup prints the resolved ids to copy in). Without pins we
// find-or-create by name, caching in module scope so warm invocations skip the
// lookup. Cold starts re-run the name lookup, which is why pinning is better —
// it removes two upstream calls from the first request after every deploy.

import { anthropic } from './util.js';

const AGENT_NAME = 'voice-code';
const ENV_NAME = 'voice-code-env';

// The trailing summary instruction pairs with the client, which reads the tail
// of the final message aloud — without it, long technical answers make bad TTS.
const SYSTEM_PROMPT = [
  'You are a coding agent driven by voice from a phone. Work autonomously in the sandbox:',
  'clone repos with git when asked, run commands, edit files, and verify your work.',
  'Keep responses tight — the user is often listening, not reading.',
  'Always end your final message of a turn with a one- or two-sentence plain-language',
  'summary of what you did or found, suitable for being read aloud.',
].join(' ');

let cached = null;

async function findByName(listPath, name) {
  try {
    const page = await anthropic(listPath, { query: { limit: 100 } });
    return (page?.data || []).find((x) => x.name === name) || null;
  } catch {
    // List endpoints failing shouldn't block session creation; fall through to create.
    return null;
  }
}

export async function resolveAgentAndEnv() {
  const pinnedAgent = process.env.ANTHROPIC_AGENT_ID;
  const pinnedEnv = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (pinnedAgent && pinnedEnv) return { agentId: pinnedAgent, environmentId: pinnedEnv };
  if (cached) return cached;

  let agentId = pinnedAgent;
  if (!agentId) {
    const existing = await findByName('/v1/agents', AGENT_NAME);
    if (existing) {
      agentId = existing.id;
    } else {
      const created = await anthropic('/v1/agents', {
        method: 'POST',
        body: {
          name: AGENT_NAME,
          model: process.env.VOICE_AGENT_MODEL || 'claude-opus-4-8',
          system: SYSTEM_PROMPT,
          tools: [{ type: 'agent_toolset_20260401' }],
        },
      });
      agentId = created.id;
    }
  }

  let environmentId = pinnedEnv;
  if (!environmentId) {
    const existing = await findByName('/v1/environments', ENV_NAME);
    if (existing) {
      environmentId = existing.id;
    } else {
      const created = await anthropic('/v1/environments', {
        method: 'POST',
        body: {
          name: ENV_NAME,
          config: { type: 'cloud', networking: { type: 'unrestricted' } },
        },
      });
      environmentId = created.id;
    }
  }

  cached = { agentId, environmentId };
  return cached;
}
