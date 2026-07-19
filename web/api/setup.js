// GET /api/setup — health/bootstrap check. Verifies env vars, resolves (or
// creates) the agent + environment, and returns their ids so they can be pinned
// as ANTHROPIC_AGENT_ID / ANTHROPIC_ENVIRONMENT_ID in Vercel settings.

import { requireAuth, json, fail } from './_lib/util.js';
import { resolveAgentAndEnv } from './_lib/agent.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { agentId, environmentId } = await resolveAgentAndEnv();
    json(res, 200, {
      ok: true,
      agent_id: agentId,
      environment_id: environmentId,
      pinned: !!(process.env.ANTHROPIC_AGENT_ID && process.env.ANTHROPIC_ENVIRONMENT_ID),
      deepgram_configured: !!process.env.DEEPGRAM_API_KEY,
      code_sessions_configured: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
    });
  } catch (err) {
    fail(res, err);
  }
}
