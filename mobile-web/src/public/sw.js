/* Voice Harness service worker — Web Push notifications, tap-to-open, and the two
   things you can do without opening the app: answer a permission prompt from the
   notification's buttons, and hear Claude's reply read aloud (▶ Play).

   The /m app shell is cached stale-while-revalidate so the UI and locally cached
   session cards appear while the harness is waking up. API responses are never
   service-worker cached. The auth token lives in a separate Cache entry because
   service workers cannot read localStorage. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const TOKEN_CACHE = 'cvh-auth';
const TOKEN_KEY = '/__cvh_token';
const SHELL_CACHE = 'cvh-shell-v1';

// Cache only UI assets and the navigation shell. Live /api and /ws data always
// bypasses this handler and retains its existing freshness semantics.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !(url.pathname === '/m' || url.pathname.startsWith('/m/'))) return;
  const key = req.mode === 'navigate' ? new Request('/m/') : req;
  const update = fetch(req).then(async (response) => {
    if (response.ok) (await caches.open(SHELL_CACHE)).put(key, response.clone());
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(key).then((cached) => cached || update));
});

async function saveToken(t) {
  const c = await caches.open(TOKEN_CACHE);
  await c.put(TOKEN_KEY, new Response(t || ''));
}
async function loadToken() {
  try {
    const c = await caches.open(TOKEN_CACHE);
    const r = await c.match(TOKEN_KEY);
    return r ? await r.text() : '';
  } catch {
    return '';
  }
}
async function authHeaders() {
  const t = await loadToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// The page hands us its token (and re-hands it on every load, so a rotated one lands).
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'auth') event.waitUntil(saveToken(d.token));
});

// Android shows 2 action buttons; a desktop UA may allow more. Extras are dropped
// silently, so order by what matters most on the smallest device.
const MAX_ACTIONS = (self.Notification && self.Notification.maxActions) || 2;

// "1. Yes, and don't ask again" -> "Yes, and don't ask…" — the button is narrow.
function shortLabel(s) {
  const t = String(s || '').replace(/^\s*\d+[.)]\s*/, '').trim();
  return t.length > 22 ? t.slice(0, 21) + '…' : t || 'Answer';
}

// Turn Claude's numbered picker into accept/reject buttons: the first option (the
// affirmative one, by Claude Code's own ordering) and the refusing one — matched by
// wording, falling back to the last option, which is where "No" normally sits.
function promptActions(prompt) {
  const opts = (prompt && prompt.options ? prompt.options : []).filter((o) => o && o.label);
  if (opts.length < 2) return [];
  const yes = opts[0];
  const no =
    opts.slice(1).find((o) => /^\s*(no\b|don'?t|reject|cancel|skip|keep)/i.test(o.label)) || opts[opts.length - 1];
  const out = [{ action: 'opt:' + yes.n, title: shortLabel(yes.label) }];
  if (no && no.n !== yes.n) out.push({ action: 'opt:' + no.n, title: shortLabel(no.label) });
  return out;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const sessionId = data.sessionId || null;

  event.waitUntil(
    (async () => {
      // Skip the toast if the app is already open and focused — you can see the state
      // there. A test push always shows so you can confirm push works.
      if (data.kind !== 'test') {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (clients.some((c) => c.focused && c.visibilityState === 'visible')) return;
      }

      // A "needs input" push means a picker is on screen right now. Ask the harness what
      // it says, so the buttons are this prompt's real options rather than a guess. The
      // question also becomes what ▶ Play speaks.
      let prompt = null;
      if (data.kind === 'input' && sessionId) {
        try {
          const r = await fetch(`/api/sessions/${sessionId}/prompt`, { headers: await authHeaders() });
          if (r.ok) prompt = (await r.json()).prompt || null;
        } catch {
          /* offline — fall back to a plain notification */
        }
      }

      const actions = [];
      if (prompt && !prompt.multi) actions.push(...promptActions(prompt));
      if (sessionId) actions.push({ action: 'play', title: '▶ Play' });

      await self.registration.showNotification(data.title || 'Voice Harness', {
        body: data.body || '',
        tag: data.tag || 'harness',
        renotify: true,
        // Ask for an *alerting* notification: sound + vibration, not a silent tray drop.
        silent: false,
        vibrate: [200, 100, 200],
        icon: '/m/icon.svg',
        badge: '/m/icon.svg',
        actions: actions.slice(0, MAX_ACTIONS),
        data: { sessionId, kind: data.kind || null, say: prompt ? promptSpeech(prompt) : null },
      });
    })()
  );
});

// Spoken form of a picker: the question, then its numbered options — the same thing the
// session view reads out, so a notification sounds like being in the session.
function promptSpeech(p) {
  const q = String(p.question || 'Claude needs your input.').trim();
  const opts = (p.options || []).map((o) => `${o.n}. ${o.label}`).join('. ');
  return opts ? `Claude is asking: ${q}. Options: ${opts}.` : `Claude is asking: ${q}`;
}

// Open (or focus) the app on this session. Prefer messaging a live client — it switches
// in place, no reload — and only navigate/open a window when there's nothing running.
async function openSession(sessionId, play) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = clients.find((c) => c.url.includes('/m'));
  if (app) {
    app.postMessage({ type: 'open-session', sessionId, play: !!play });
    if ('focus' in app) return app.focus();
    return undefined;
  }
  const url = '/m' + (sessionId ? '?s=' + sessionId + (play ? '&play=1' : '') : '');
  if (self.clients.openWindow) return self.clients.openWindow(url);
  return undefined;
}

// ▶ Play — read Claude's latest reply (or the pending question) aloud wherever you are.
// A service worker has no audio, so a page has to do it: message any live client, even a
// backgrounded one, and only open the app if none exists.
async function speak(sessionId, say) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = clients.find((c) => c.url.includes('/m'));
  if (app) {
    app.postMessage({ type: 'speak', sessionId, say: say || null });
    return undefined;
  }
  if (self.clients.openWindow) return self.clients.openWindow('/m?s=' + sessionId + '&play=1');
  return undefined;
}

// Answer the picker straight from the notification. wait:false so the harness submits the
// keystrokes and returns — waiting out Claude's whole next turn would kill the worker.
async function answer(sessionId, index, title) {
  const r = await fetch(`/api/sessions/${sessionId}/select`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, wait: false }),
  });
  const ok = r.ok;
  await self.registration.showNotification(ok ? '✓ Answered' : '⚠ Couldn’t answer', {
    body: ok ? `Sent "${title}" to Claude.` : 'The prompt may have already been answered.',
    tag: `sess-${sessionId}`,
    icon: '/m/icon.svg',
    badge: '/m/icon.svg',
    silent: true,
    data: { sessionId },
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  const sessionId = d.sessionId;
  n.close();

  event.waitUntil(
    (async () => {
      if (!sessionId) return openSession(null, false);
      if (event.action === 'play') return speak(sessionId, d.say);
      if (event.action.startsWith('opt:')) {
        const index = Number(event.action.slice(4));
        const btn = (n.actions || []).find((a) => a.action === event.action);
        try {
          return await answer(sessionId, index, btn ? btn.title : `option ${index}`);
        } catch {
          return openSession(sessionId, false); // network hiccup — let them answer in the app
        }
      }
      return openSession(sessionId, false); // body tap
    })()
  );
});
