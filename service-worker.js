/* One Stop Heating and Cooling — Service Worker
 * Red primero para HTML (siempre la versión más nueva), caché primero para
 * estáticos. La API/D1 nunca se cachea (ver API_PREFIX). Al publicar una
 * versión nueva: subir CACHE de v1 a v2 para que los usuarios reciban lo
 * nuevo sin quedar pegados en lo viejo.
 */
const CACHE = 'onestop-shell-v12';
const API_PREFIX = '/api';
const SHELL = [
  './',
  './index.html',
  './data.js',
  './i18n.js',
  './manifest.webmanifest',
  './assets/apple-touch-icon.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Maps y fuentes: directo a la red
  if (url.pathname.startsWith(API_PREFIX)) return;  // datos propios (futuro Worker/D1): nunca se cachean

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
    }))
  );
});
