// POST /api/hooks/stop — Claude Code Stop hook target. Localhost-only (the hook
// runs on this machine). Body is Claude's Stop hook JSON; the important fields:
//   session_id, cwd, last_assistant_message, stop_reason, transcript_path.
// We forward it to the completion detector, which matches it to an in-flight
// command. Always 204 so the hook never blocks Claude.

import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { signalStop } from '../../services/claudeCode.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('hooks');
const router = Router();

router.use(localhostOnly);

router.post('/stop', (req, res) => {
  const b = req.body || {};
  try {
    signalStop({
      sessionId: b.CVH_SESSION_ID ?? b.session_id ?? b.sessionId,
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
