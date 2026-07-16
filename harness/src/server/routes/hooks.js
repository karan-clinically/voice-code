// POST /api/hooks/stop — turn-complete hook target. Localhost-only.
// Used by:
//   - Claude Code's Stop hook (settings.json)
//   - the native Grok agent (posts the same shape when a turn finishes)
// Important fields: session_id, cwd, last_assistant_message, stop_reason,
// transcript_path, plus the X-CVH-Session header (or a CVH_SESSION_ID body field
// from Grok). Forwarded to the completion detector, which matches it to an
// in-flight command. Always 204 so the hook never blocks.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { signalStop } from '../../services/claudeCode.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('hooks');
const router = Router();

router.use(localhostOnly);

// Our per-PTY correlation token. Claude's Stop hook payload has no field to carry
// it, so the hook interpolates it into a header from the PTY's env (settings.json
// Stop hook: type "http" + allowedEnvVars); the native Grok agent posts it in the
// body instead. A Claude the harness didn't spawn has no token: the header is then
// empty, or literal `%VAR%`/`$VAR` if the hook is ever moved back to a shell/curl
// form that leaves unset variables unexpanded. Treat all of those as "no token" —
// falling through to cwd matching — rather than as a bogus id that matches nothing.
function cvhToken(req, b) {
  const raw = String(req.get('x-cvh-session') || b.CVH_SESSION_ID || '').trim();
  return raw && !/[%$]/.test(raw) ? raw : null;
}

router.post('/stop', (req, res) => {
  const b = req.body || {};
  try {
    signalStop({
      // Claude's transcript UUID — always its own field, never our token.
      sessionId: b.session_id ?? b.sessionId,
      token: cvhToken(req, b),
      cwd: b.cwd,
      lastAssistantMessage: b.last_assistant_message ?? b.lastAssistantMessage,
      stopReason: b.stop_reason,
      transcriptPath: b.transcript_path,
    });
  } catch (err) {
    log.error(`stop hook error: ${err.message}`);
  }
  res.status(204).end();
});

export default router;
