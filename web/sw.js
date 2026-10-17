// @ts-check
// The offline copy. The app shell is served from the cache and refreshed in the background; the reading data (items,
// briefings, health) is fetched fresh when online and falls back to the last copy when not. Nothing else is cached:
// not feed logins, rules, pipes or any write. Fonts from Google are left to the browser's own cache.
/** @type {any} */
const sw = self;

// The server writes the app's version here, and puts the same ?v= on every script and stylesheet address, so a new release gets a new
// cache and new addresses, and nothing old is served from any cache along the way.
const VERSION = "__JUHANDU_VERSION__";
const SHELL = `juhandu-shell-${VERSION}`;
const DATA = "juhandu-data-v1";
const FILES = ["/", "/app.js", "/ui.js", "/gestures.js", "/briefing.js", "/rules.js", "/feeds.js", "/pipes.js", "/watch.js", "/connect.js", "/setup.js", "/login.js", "/tokens.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"];
/** The shell files under the addresses the page asks for. */
const VERSIONED = FILES.map((file) => (/\.(js|css)$/.test(file) ? `${file}?v=${VERSION}` : file));
const READABLE =/^\/api\/(items|health|briefings(\/\d+)?)$/;

sw.addEventListener("install", (/** @type {any} */ event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(VERSIONED)).then(() => sw.skipWaiting()));
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

// Where the browser allows it, an installed app wakes now and then to refresh the unread count on its icon.
sw.addEventListener("periodicsync", (/** @type {any} */ event) => {
  if (event.tag === "juhandu-badge") event.waitUntil(refreshBadge());
});

async function refreshBadge() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    const { unread } = await response.json();
    if (unread > 0) await sw.navigator.setAppBadge?.(unread);
    else await sw.navigator.clearAppBadge?.();
  } catch {
    // Offline, or signed out: the count stays as it was.
  }
}

/** @param {Request} request */
async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    // Only the first page of a list is kept for offline; the pages further down would pile up one copy per place the reader scrolled to.
    if (response.ok && !new URL(request.url).searchParams.has("before")) await cache.put(request, response.clone());
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
