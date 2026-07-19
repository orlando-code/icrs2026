/* Offline support. The programme is static, so cache-first is correct and the
   whole app works with no wifi once it has been opened once. Bump CACHE when
   data/programme.json is rebuilt so clients pick up the new data. */
var CACHE = 'icrs2026-v4';
// data/abstracts.json (~3.9 MB) is deliberately NOT precached: it would make
// install slow on venue wifi. The app fetches it in the background after first
// render and the runtime cache below picks it up, so offline still gets it.
var ASSETS = [
  './',
  'index.html',
  'assets/styles.css',
  'assets/app.js',
  'assets/qrcode.js',
  'assets/icon.svg',
  'data/programme.json',
  'manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        // refresh in the background so a redeploy is picked up next visit
        fetch(e.request).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(e.request).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        if (e.request.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
