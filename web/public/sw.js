// Fitness app service worker. Deliberately small:
//  - never caches /api or /api/files (check-ins, points and evidence always come live from the server);
//  - caches the built app files (/assets/*, content-hashed) so the app opens fast;
//  - page loads go to the network first; without a connection the last app shell (or an offline note) is shown;
//  - phone notifications: shows them, and tapping one opens the app on that page (the app asks to sign in if needed).
const CACHE = 'fitness-shell-v1';

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { title: e.data ? e.data.text() : '' }; }
  const url = typeof msg.url === 'string' && msg.url.startsWith('/') ? msg.url : '/notifications';
  e.waitUntil(self.registration.showNotification(msg.title || 'Fitness', {
    body: msg.body || 'You have a new alert.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: msg.tag || 'fitness',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/notifications', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) return c.navigate(url);
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/offline.html']).catch(() => undefined))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
    return;
  }
  if (req.mode === 'navigate') {
    // Only the app's own page is kept for offline use (not a downloaded file such as the Apple Shortcut).
    e.respondWith(fetch(req).then((res) => { if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); } return res; })
      .catch(() => caches.match('/').then((hit) => hit || caches.match('/offline.html'))));
  }
});
