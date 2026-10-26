// Network first, so the app always talks to the current daemon; the cached shell only
// shows when the daemon is unreachable, and then reconnects on its own.
const CACHE = "fleet-shell";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // The history view streams server-sent events; caching would buffer them forever.
  if (url.pathname.startsWith("/orbit/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(
        async () => (await caches.match(request)) ?? (await caches.match("/")) ?? Response.error(),
      ),
  );
});
