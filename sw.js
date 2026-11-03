// ATAM GO — app-shell service worker.
// Caches only static UI files (HTML/CSS/JS/icons) for fast loads and basic
// offline resilience. Deliberately does NOT touch Supabase or n8n requests —
// every dashboard number always comes straight from the network, never cache.

const CACHE = 'atamgo-shell-v5';

const SHELL = [
  './',
  './index.html',
  './login.html',
  './styles.css',
  './enhancements.css',
  './revenue.css',
  './mobile.css',
  './app.js',
  './enhancements.js',
  './dispatch.js',
  './effects3d.js',
  './weekly-targets.js',
  './revenue.js',
  './payments.js',
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

// ---- Phone alerts (web push) ----
// The sender (an n8n workflow) pushes a small encrypted JSON message {title, body, url, tag}. A browser requires every push to show a
// notification, so this always does, even if the message cannot be read.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'ATAM GO';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'favicon-32.png',
    tag: data.tag || undefined,
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping an alert: use the ATAM GO window that is already open (and tell it where to go), or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  const go = (new URL(target, self.registration.scope).searchParams.get('go')) || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          c.postMessage({ type: 'atamgo-go', go });
          return c.focus();
        }
      }
      return self.clients.openWindow(new URL('index.html' + (go ? '?go=' + encodeURIComponent(go) : ''), self.registration.scope).href);
    })
  );
});
