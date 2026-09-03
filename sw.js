const CACHE_NAME = "ruteo-shell-v36";
const APP_SHELL = ["./", "index.html", "styles.css?v=36", "map-engine.js?v=36", "route-export.js?v=36", "gps-speed.js?v=36", "route-import.js?v=36", "density-analysis.js?v=36", "route-optimizer.js?v=36", "dijkstra-routing.js?v=36", "app.js?v=36", "manifest.webmanifest", "icon.svg", "logo-upc.jpg?v=36", "garbage-truck-marker.png?v=36"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});

