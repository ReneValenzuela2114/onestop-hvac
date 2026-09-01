/* One Stop Heating and Cooling — Service Worker
 *
 * EL CÓDIGO DE LA APP VIAJA JUNTO O NO VIAJA.
 * index.html, data.js e i18n.js cambian en el mismo cambio y se necesitan
 * entre ellos: el HTML nuevo llama a funciones que solo existen en el data.js
 * nuevo. Si el HTML viene de la red y el JS del caché, la app queda a medias
 * —el botón está pero no hace nada— y no se ve ningún error.
 * Pasó de verdad al publicar Cotizaciones. Por eso los tres van RED PRIMERO,
 * con el caché únicamente como respaldo para trabajar sin señal.
 *
 * Lo que no cambia entre versiones (íconos, manifest) sí va caché primero:
 * es lo que hace que la app abra al instante.
 *
 * La API nunca se cachea (ver API_PREFIX).
 *
 * Al publicar: subir CACHE de vNN a vNN+1.
 */
const CACHE = 'onestop-shell-v47';
const API_PREFIX = '/api';

/* Los tres archivos que forman la app y tienen que coincidir entre sí */
const CODIGO_DE_LA_APP = ['/', '/index.html', '/data.js', '/i18n.js'];

const SHELL = [
  './',
  './index.html',
  './data.js',
  './i18n.js',
  './datos-ejemplo.json',
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

/* ¿Es uno de los tres archivos que forman la app? */
function esCodigoDeLaApp(url) {
  const ruta = url.pathname.replace(/\/index\.html$/, '/');
  return CODIGO_DE_LA_APP.some((p) => ruta.endsWith(p) || url.pathname.endsWith(p));
}

/* Red primero: si hay señal, siempre la versión más nueva. Sin señal, la
   última que se guardó — que es coherente porque se guardó completa.

   `cache: 'no-cache'` no significa "no guardes": significa "preguntale al
   servidor si cambió antes de usar lo guardado". Sin esto, el navegador le
   contesta al service worker desde SU propio caché y volvemos al mismo
   problema: HTML nuevo con JavaScript viejo. Si no cambió, el servidor
   responde 304 y no se baja nada. */
function redPrimero(req, claveCache) {
  return fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }))
    .then((res) => {
      const copia = res.clone();
      caches.open(CACHE).then((c) => c.put(claveCache || req, copia));
      return res;
    })
    .catch(() => caches.match(claveCache || req).then((hit) => hit || caches.match('./index.html')));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Maps y fuentes: directo a la red
  if (url.pathname.startsWith(API_PREFIX)) return;  // datos propios (Worker/D1): nunca se cachean

  if (req.mode === 'navigate') {
    e.respondWith(redPrimero(req, './index.html'));
    return;
  }

  if (esCodigoDeLaApp(url)) {
    e.respondWith(redPrimero(req));
    return;
  }

  /* Íconos y manifest: caché primero, que es lo que hace que abra al instante */
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copia = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copia));
      return res;
    }))
  );
});
