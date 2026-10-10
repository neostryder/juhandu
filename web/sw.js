// @ts-check
// The offline copy. The app shell is served from the cache and refreshed in the background; the reading data (items,
// briefings, health) is fetched fresh when online and falls back to the last copy when not. Nothing else is cached:
// not feed logins, rules, pipes or any write. Fonts from Google are left to the browser's own cache.
/** @type {any} */
const sw = self;

const SHELL = "juhandu-shell-v1";
const DATA = "juhandu-data-v1";
const FILES = ["/", "/app.js", "/ui.js", "/briefing.js", "/rules.js", "/feeds.js", "/pipes.js", "/connect.js", "/login.js", "/tokens.css", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const READABLE = /^\/api\/(items|health|briefings(\/\d+)?)$/;

sw.addEventListener("install", (/** @type {any} */ event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (/** @type {any} */ event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => (n.startsWith("juhandu-shell") && n !== SHELL) || (n.startsWith("juhandu-data") && n !== DATA)).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (/** @type {any} */ event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    if (!READABLE.test(url.pathname)) return;
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith("/pipes/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/").then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

/** @param {Request} request */
async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    if (!hit) return Response.error();
    // Tell the page this is the saved copy, so it can say so.
    const headers = new Headers(hit.headers);
    headers.set("x-juhandu-saved", "1");
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

/** @param {Request} request */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit ?? Response.error());
  return hit ?? fresh;
}
