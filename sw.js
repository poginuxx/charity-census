// Service worker — exists so the app is installable as a PWA.
// Strategy: network-first, cache fallback. The user is always online, so the
// cache is only a safety net; we never want a stale app shell served over a
// fresh one.

const CACHE = 'charity-census-v8';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './lib/parser.js',
  './lib/trends.js',
  './lib/identity.js',
  './lib/store.js',
  './lib/diff.js',
  './lib/deid.js',
  './lib/triage.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache good responses — a cached 404/500 would otherwise be
        // served forever once the network drops.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Offline navigation to an uncached URL: serve the app shell rather
        // than letting respondWith reject into a browser error page.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
