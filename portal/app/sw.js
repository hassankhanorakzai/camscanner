// Offline app shell. API calls (api.php) are never cached here; encrypted data lives in IndexedDB.
const VERSION = 'smartscan-app-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'css/base.css', 'css/phone.css', 'js/main.js', 'js/net.js', 'js/sync.js', 'js/ui.js', 'js/scan/cv.js', 'js/scan/editor.js', 'worker/cv-worker.js', 'vendor/opencv.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/api.php')) return;
  // network first for the app code (gets updates), cache as fallback when offline
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
