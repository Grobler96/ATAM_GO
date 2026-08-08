// ATAM GO — app-shell service worker.
// Caches only static UI files (HTML/CSS/JS/icons) for fast loads and basic
// offline resilience. Deliberately does NOT touch Supabase or n8n requests —
// every dashboard number always comes straight from the network, never cache.

const CACHE = 'atamgo-shell-v2';

const SHELL = [
  './',
  './index.html',
  './login.html',
  './styles.css',
  './enhancements.css',
  './revenue.css',
  './app.js',
  './enhancements.js',
  './dispatch.js',
  './effects3d.js',
  './weekly-targets.js',
  './revenue.js',
  './config.js',
  './atam-go-logo.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept cross-origin requests (Supabase, n8n webhooks, fonts, CDN
  // scripts). Those always go straight to the network, live, every time.
  if (url.origin !== location.origin) return;

  // Same-origin shell files: try the network first (so updates are picked up
  // immediately whenever online), fall back to the cached copy only if offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
