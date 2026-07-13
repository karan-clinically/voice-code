/* Voice Harness service worker — Web Push notifications + tap-to-open. Kept tiny:
   no offline caching (the app needs the live harness anyway), just push. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Voice Harness';
  const options = {
    body: data.body || '',
    tag: data.tag || 'harness',
    renotify: true,
    icon: '/m/icon.svg',
    badge: '/m/icon.svg',
    data: { sessionId: data.sessionId || null, kind: data.kind || null },
  };
  event.waitUntil(
    (async () => {
      // Skip the toast if the app is already open and focused — you can see the
      // state there. A test push always shows so you can confirm it works.
      if (data.kind !== 'test') {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (clients.some((c) => c.focused && c.visibilityState === 'visible')) return;
      }
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const url = '/m' + (sessionId ? '?s=' + sessionId : '');
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        if (c.url.includes('/m') && 'focus' in c) {
          if ('navigate' in c && sessionId) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
