/* Minimal service worker for Rich Music.
   Purpose: satisfy the PWA install criteria (installable app) WITHOUT caching
   assets — a stale cache was the reason the old SW was removed. We take control
   immediately and always serve from the network, so updates are never stale. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
/* Pure network pass-through (no offline cache). A no-op fetch handler is still
   required for some browsers to treat the app as installable. */
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});
