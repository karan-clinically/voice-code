// PWA + Web Push wiring for the phone. Registers the service worker (making the app
// installable), and subscribes/unsubscribes this device for background notifications.

import { pushVapid, pushSubscribe, pushUnsubscribe, authToken } from './api.js';

const SCOPE = '/m/';
const SW_URL = '/m/sw.js';

// Hand the worker our auth token. It answers permission prompts (POST /select) from the
// notification's buttons, and can't reach localStorage to find the token itself. Re-sent
// on every load so a rotated token lands; harmless when there's no token (localhost).
async function shareToken() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sw = reg.active || navigator.serviceWorker.controller;
    if (sw) sw.postMessage({ type: 'auth', token: authToken() });
  } catch {
    /* no worker yet — the next load shares it */
  }
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Register the SW on app load so the app is installable and the push machinery is
// ready. Safe to call every load — register() is idempotent.
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
    shareToken();
    return reg;
  } catch {
    return null;
  }
}

async function getReg() {
  return (await navigator.serviceWorker.getRegistration(SCOPE)) || (await registerSW());
}

export async function notificationsOn() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  return !!(reg && (await reg.pushManager.getSubscription()));
}

// VAPID public key (base64url) -> Uint8Array for applicationServerKey.
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enableNotifications() {
  if (!pushSupported()) throw new Error('This browser doesn’t support notifications.');
  const { enabled, publicKey } = await pushVapid();
  if (!enabled || !publicKey) throw new Error('Push isn’t configured on the harness (missing VAPID keys).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked — allow them in the browser to enable.');
  const reg = await getReg();
  if (!reg) throw new Error('Couldn’t start the service worker.');
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) }));
  await pushSubscribe(sub.toJSON());
  return true;
}

// Heal the subscription on every app load. The push service rotates endpoints (after
// long idle — e.g. the phone was off — or a browser update), and the harness prunes an
// endpoint the moment it returns 410/404. Either leaves the device silently unsubscribed
// while the browser still thinks it's on, so nothing arrives until the user re-toggles.
// Re-asserting here restores a pruned endpoint, and re-subscribes if the browser dropped
// the subscription while permission is still granted. Idempotent; never throws.
export async function syncPushSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await getReg();
    if (!reg) return;
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Permission granted but no subscription — the browser dropped it. Re-create so
      // pushes resume without the user having to revisit Settings.
      const { enabled, publicKey } = await pushVapid();
      if (!enabled || !publicKey) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
    }
    await pushSubscribe(sub.toJSON()); // upsert — restores a server-side prune
  } catch {
    /* offline / not configured — the Settings toggle is still the manual fallback */
  }
}

export async function disableNotifications() {
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}
