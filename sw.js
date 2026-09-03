const CACHE_NAME = "ruteo-shell-v37";
const APP_SHELL = ["./", "index.html", "styles.css?v=37", "map-engine.js?v=37", "route-export.js?v=37", "gps-speed.js?v=37", "route-import.js?v=37", "density-analysis.js?v=37", "route-optimizer.js?v=37", "dijkstra-routing.js?v=37", "mandatory-routing.js?v=37", "app.js?v=37", "manifest.webmanifest", "icon.svg", "logo-upc.jpg?v=37", "garbage-truck-marker.png?v=37"];

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

