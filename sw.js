const CACHE = "flashcards-v24";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./data/seed.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      // Lokala filer MÅSTE cachas (annars är installationen meningslös)
      await c.addAll(ASSETS.filter((u) => !u.startsWith("http")));
      // CDN-filer (Firebase) cachas best-effort – får inte blockera uppdateringen
      await Promise.allSettled(ASSETS.filter((u) => u.startsWith("http")).map((u) => c.add(u)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  // Firebase realtime/auth-trafik ska alltid gå till nätet
  if (url.includes("firebasedatabase.app") || url.includes("identitytoolkit") || url.includes("googleapis.com")) {
    return; // låt webbläsaren hantera (nätverk)
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
