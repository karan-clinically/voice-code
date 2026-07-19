// GET /api/setup — login check + feature discovery. The hub runs in two modes:
//
//   connector-only : just APP_ACCESS_TOKEN (+ Upstash for the PC list). The
//                    hub is a device directory into PC-hosted harnesses; no
//                    Anthropic/Deepgram keys, nothing billed here.
//   cloud sessions : ANTHROPIC_API_KEY (+ DEEPGRAM_API_KEY for voice) also
//                    set — adds PC-free Managed Agents sessions.
//
// So this endpoint must succeed with only the access token configured; it
// reports which features are live and, when cloud sessions are on, resolves
// (or creates) the agent + environment and returns their ids for pinning as
// ANTHROPIC_AGENT_ID / ANTHROPIC_ENVIRONMENT_ID.

import { requireAuth, json } from './_lib/util.js';
import { kvConfigured } from './_lib/kv.js';
import { resolveAgentAndEnv } from './_lib/agent.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  const cloud = !!process.env.ANTHROPIC_API_KEY;
  const out = {
    ok: true,
    features: {
      cloud_sessions: cloud,
      voice: !!process.env.DEEPGRAM_API_KEY,
      pcs: kvConfigured(),
      code_sessions: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
    },
  };

  if (cloud) {
    try {
      const { agentId, environmentId } = await resolveAgentAndEnv();
      out.agent_id = agentId;
      out.environment_id = environmentId;
      out.pinned = !!(process.env.ANTHROPIC_AGENT_ID && process.env.ANTHROPIC_ENVIRONMENT_ID);
    } catch (err) {
      // Cloud config problems shouldn't block login to the connector features.
      out.features.cloud_sessions = false;
      out.cloud_error = err.message;
    }
  }

  json(res, 200, out);
}
