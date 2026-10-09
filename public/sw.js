/**
 * Gridline's service worker (P11-08, P11-09).
 *
 * Hand-written, because every generated template gets this product exactly
 * wrong. The usual recipe is cache-first with an offline fallback page, which
 * for an app whose entire function is a live connection would mean an installed
 * icon that opens, looks completely normal, and quietly does nothing. The worst
 * possible failure here is one that looks like success.
 *
 * So:
 *   - Navigations are **network-first**. Offline, the cached shell is served
 *     and the app itself reports that it has no connection, which it can do
 *     honestly because it is the thing holding the socket.
 *   - Assets are stale-while-revalidate: fast, and never more than one visit
 *     out of date.
 *   - WebSocket traffic is untouched. A service worker cannot intercept it,
 *     and nothing here tries to simulate it.
 *   - Nothing is cached that could carry room content. The only things stored
 *     are the shell and its static assets; no API response, no message, no
 *     attachment. There is no cache to leak and none to clear (INV-8).
 */
const VERSION = 'gridline-v1';
const SHELL = VERSION + '-shell';

const SCOPE = new URL(self.registration.scope);
const START = new URL('./', SCOPE).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Best effort: a failed precache must not block the install, or a flaky
    // network at first visit leaves the app permanently without a worker.
    await cache.addAll([START]).catch(() => undefined);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Anything from a previous version goes. A stale shell on a static host is
    // how a deployed fix fails to reach the people who installed the app.
    await Promise.all(names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'gridline:skip-waiting') self.skipWaiting();
});

function isAsset(url) {
  return /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|webmanifest|json)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put(START, response.clone()).catch(() => undefined);
        return response;
      } catch {
        // Offline. The shell loads and says so; it does not pretend to be a
        // game that can be played.
        const cached = await caches.match(START);
        return cached ?? new Response(
          '<!doctype html><meta charset="utf-8"><title>Gridline is offline</title>'
          + '<body style="background:#0a0b0e;color:#eeede7;font:16px system-ui;padding:40px">'
          + '<h1>Gridline is offline</h1><p>Gridline is a live game between two people, '
          + 'so it needs a connection. Reconnect and reopen this page.</p>',
          { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 },
        );
      }
    })());
    return;
  }

  if (!isAsset(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
        return response;
      })
      .catch(() => cached);
    return cached ?? network;
  })());
});
