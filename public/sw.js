const CACHE_NAME = "bookcompressor-shell-v1";
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");

function scoped(path) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${SCOPE_PATH}${clean}`;
}

const SHELL_ASSETS = [scoped("/"), scoped("/manifest.webmanifest"), scoped("/icon.svg")];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      if (request.mode === "navigate") {
        const fallback = await caches.match(scoped("/"));
        if (fallback) return fallback;
      }

      throw new Error("Network unavailable and no cache fallback found.");
    }),
  );
});

