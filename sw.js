/* Offline support. The programme is static, so cache-first is correct and the
   whole app works with no wifi once it has been opened once. Bump CACHE when
   data/programme.json is rebuilt so clients pick up the new data. */
var CACHE = 'icrs2026-v24';
// data/abstracts.json (~3.9 MB) is deliberately NOT precached: it would make
// install slow on venue wifi. The app fetches it in the background after first
// render and the runtime cache below picks it up, so offline still gets it.
var ASSETS = [
  './',
  'index.html',
  'assets/styles.css',
  'assets/personal.css',
  'assets/site-mode.js',
  'assets/app.js',
  'assets/personal-sync.js',
  'assets/sync-config.js',
  'assets/qrcode.js',
  'assets/icon.svg',
  'data/programme.json',
  'manifest.webmanifest'
];

function isShellRequest(req, url) {
  if (req.mode === 'navigate') return true;
  return /\/assets\/(app|site-mode|sync-config|personal-sync)\.js$/.test(url.pathname) ||
    /\/assets\/(styles|personal)\.css$/.test(url.pathname) ||
    /\/index\.html$/.test(url.pathname);
}

function putCache(req, res) {
  if (res && res.ok && res.type === 'basic') {
    caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
  }
}

function networkFirst(req) {
  return fetch(req).then(function (res) {
    putCache(req, res);
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('index.html') || caches.match('./');
      }
      throw new Error('offline');
    });
  });
}

function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) {
      fetch(req).then(function (res) { putCache(req, res); }).catch(function () {});
      return hit;
    }
    return fetch(req).then(function (res) {
      putCache(req, res);
      return res;
    }).catch(function () {
      if (req.mode === 'navigate') return caches.match('index.html') || caches.match('./');
      throw new Error('offline');
    });
  });
}

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

  if (isShellRequest(e.request, url)) {
    e.respondWith(networkFirst(e.request));
    return;
  }
  e.respondWith(cacheFirst(e.request));
});
