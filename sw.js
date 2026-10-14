// Lets the app open without a connection. Always tries the network first so updates
// you push to GitHub show up right away; falls back to the saved copy when offline.
const CACHE = 'planner-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/config.js', 'js/util.js', 'js/ui.js', 'js/google.js', 'js/local.js',
  'js/data.js', 'js/events.js', 'js/tasks.js', 'js/recurrence.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache Google API or sign-in traffic.
  if (/googleapis\.com|accounts\.google\.com/.test(url.hostname) && !/fonts\.googleapis\.com/.test(url.hostname)) return;

  const sameOrigin = url.origin === location.origin;
  const library = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!sameOrigin && !library) return;

  if (library) {
    // Pinned library versions never change: serve from cache when we have them.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
});
