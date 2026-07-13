// Web Push endpoints for the phone app.
//   GET  /api/push/vapid        — public VAPID key + whether push is enabled
//   POST /api/push/subscribe    — register this device's push subscription
//   POST /api/push/unsubscribe  — drop it (endpoint)
//   POST /api/push/test         — send a test notification to all devices

import { Router } from 'express';
import {
  saveSubscription, removeSubscription, vapidPublicKey, pushConfigured, sendToAll, subscriptionCount,
} from '../../services/push.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('push-route');
const router = Router();

router.get('/vapid', (req, res) => {
  res.json({ enabled: pushConfigured(), publicKey: vapidPublicKey(), devices: subscriptionCount() });
});

router.post('/subscribe', (req, res) => {
  try {
    saveSubscription(req.body?.subscription);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/unsubscribe', (req, res) => {
  removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  try {
    const sent = await sendToAll({
      title: '🔔 Voice Harness', body: 'Notifications are working.', kind: 'test', tag: 'test',
    });
    res.json({ ok: true, sent });
  } catch (err) {
    log.warn(`test push failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
