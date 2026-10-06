// Offline support for the self-hosted build. build.py fills in the cache name and file list.
const CACHE = "{{CACHE}}";
const FILES = {{FILES}};

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("orvy-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    // The page itself: network first so updates arrive, cache when offline.
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put("index.html", copy));
      return res;
    }).catch(() => caches.match("index.html")));
    return;
  }
  event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
