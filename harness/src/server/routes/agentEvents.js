import { Router } from 'express';
import { localhostOnly } from '../auth.js';
import { acceptAgentEvent } from '../../services/agentEvents.js';

const router = Router();
router.use(localhostOnly);

router.post('/', (req, res) => {
  try {
    const accepted = acceptAgentEvent(req.body || {});
    res.status(accepted ? 202 : 200).json({ accepted: !!accepted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
