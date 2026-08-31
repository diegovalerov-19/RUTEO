const CACHE_NAME = "ruteo-shell-v30";
const APP_SHELL = ["./", "index.html", "styles.css?v=30", "map-engine.js?v=30", "route-export.js?v=30", "gps-speed.js?v=30", "route-import.js?v=30", "density-analysis.js?v=30", "route-optimizer.js?v=30", "app.js?v=30", "manifest.webmanifest", "icon.svg", "logo-upc.jpg?v=30", "garbage-truck-marker.png?v=30"];

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

