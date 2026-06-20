/* Tailwinds service worker — network-first, offline fallback.
 *
 * Design goals:
 *  - NEVER serve a stale app. Always try the network first; only fall back to
 *    cache when the device is offline. This avoids the classic "users stuck on
 *    an old build" PWA problem.
 *  - Make the game installable + usable offline (last-seen version).
 *  - Be trivially removable: see ROLLBACK.md for the kill-switch worker that
 *    unregisters this and clears its caches.
 *
 * Bump CACHE_VERSION on any meaningful change to force old caches out.
 */
const CACHE_VERSION = 'tailwinds-v1';

self.addEventListener('install', (event) => {
  // Activate this worker as soon as it's installed (don't wait for old tabs).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests. Let everything else (ads, fonts,
  // analytics, POSTs) go straight to the network untouched.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        // Network first.
        const fresh = await fetch(req);
        // Cache a copy of successful basic responses for offline use.
        if (fresh && fresh.status === 200 && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        // Offline: fall back to cache.
        const cached = await caches.match(req);
        if (cached) return cached;
        // For navigations with nothing cached, fall back to the app shell.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});

// Allow the page to tell a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
