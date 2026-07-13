// Web Push: store per-device subscriptions and send notifications to them. VAPID
// keys come from harness/.env (generated once at setup). A subscription the push
// service reports as gone (404/410) is pruned so the table stays clean.

import webpush from 'web-push';
import db from '../db.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('push');

// Read VAPID keys lazily. index.js loads harness/.env in its module body, which ESM
// runs AFTER all imports — so reading process.env at import time here would see it
// empty. First use happens at request/watcher time, well after .env is loaded.
let inited = false;
let PUB = '';
let PRIV = '';
let configured = false;
function init() {
  if (inited) return;
  inited = true;
  PUB = process.env.VAPID_PUBLIC_KEY || '';
  PRIV = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  configured = !!(PUB && PRIV);
  if (configured) webpush.setVapidDetails(subject, PUB, PRIV);
  else log.warn('VAPID keys missing from .env — push notifications disabled');
}

export function pushConfigured() {
  init();
  return configured;
}
export function vapidPublicKey() {
  init();
  return PUB;
}

const upsert = db.prepare(
  `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
);
const delByEndpoint = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
const selAll = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions');

export function saveSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('invalid subscription');
  upsert.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}
export function removeSubscription(endpoint) {
  if (endpoint) delByEndpoint.run(endpoint);
}
export function subscriptionCount() {
  return selAll.all().length;
}

// Fan a payload out to every subscribed device; prune the dead ones. Returns how
// many were delivered. Never throws — a bad device can't break a session event.
export async function sendToAll(payload) {
  init();
  if (!configured) return 0;
  const subs = selAll.all();
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subs.map(async (row) => {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(sub, body, { TTL: 600, urgency: 'high' });
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          delByEndpoint.run(row.endpoint);
          log.info('pruned a dead push subscription');
        } else {
          log.warn(`push send failed (${err.statusCode || '?'}): ${err.message}`);
        }
      }
    })
  );
  return sent;
}
