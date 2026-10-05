// DumboFly service worker.
//
// What this is for, in order of how much it matters to the family:
//
//  1. The trip opens on a phone with no signal. Seoul's subway has patchy
//     data and roaming is expensive, so the app shell is cached and the page
//     still opens rather than showing the browser's dinosaur.
//  2. Photos stop costing money twice. The 226 stored place photos are
//     immutable — the URL only ever serves those exact bytes — so once a
//     phone has one it never fetches it again.
//  3. It makes the app installable, which is the point of the manifest.
//
// What it deliberately does NOT do: cache anything from Supabase's REST or
// functions API. The itinerary is edited by several people at once, and
// serving one of them a stale snapshot that then gets saved back over
// somebody's newer edit would lose real work. Data is always network-only.

// Bumped when the cached shell changes — v2 carried the redrawn app icon.
// v3: navigations revalidate instead of trusting the HTTP cache, so a deploy
// reaches an installed app without it being reinstalled.
const VERSION = "v3";
const SHELL = `dumbofly-shell-${VERSION}`;
const ASSETS = `dumbofly-assets-${VERSION}`;
const PHOTOS = `dumbofly-photos-${VERSION}`;

// Everything needed to render the app with no network at all.
const SHELL_FILES = [
  "/",
  "/index.html",
  "/trip.html",
  "/manifest.webmanifest",
  "/icons/icon-192-v2.png",
  "/icons/icon-512-v2.png",
  "/icons/icon-v2.svg",
  "/icons/apple-touch-icon-v2.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One bad URL must not fail the whole install, so they go in one at a time.
    await Promise.all(SHELL_FILES.map(u =>
      cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, ASSETS, PHOTOS];
    for (const k of await caches.keys()) {
      if (k.startsWith("dumbofly-") && !keep.includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// Let the page ask for an immediate update after a deploy.
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

const isSupabaseData = (url) =>
  url.pathname.startsWith("/rest/v1/") ||
  url.pathname.startsWith("/functions/v1/") ||
  url.pathname.startsWith("/auth/v1/");

const isStoredPhoto = (url) =>
  url.pathname.startsWith("/storage/v1/object/public/");

const isFontOrLib = (url) =>
  url.hostname === "fonts.googleapis.com" ||
  url.hostname === "fonts.gstatic.com" ||
  url.hostname === "unpkg.com";

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque responses (no-cors) are fine to keep; they still replay offline.
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || net || fetch(req);
}

// Navigations go to the network first so a deploy is picked up straight away,
// and fall back to the cached shell only when the network cannot answer.
async function navigate(req) {
  try {
    // "no-cache" means: always ask the server whether this changed. Without it
    // the browser could answer from its own HTTP cache and an installed app
    // would keep running an old page no matter how many times it was reloaded.
    const res = await fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }));
    if (res && res.ok) {
      const cache = await caches.open(SHELL);
      const url = new URL(req.url);
      // Key on the path, so trip.html?trip=1 and ?trip=2 share one entry.
      cache.put(url.pathname === "/" ? "/" : url.pathname, res.clone());
    }
    return res;
  } catch (e) {
    const url = new URL(req.url);
    const cache = await caches.open(SHELL);
    return (await cache.match(url.pathname === "/" ? "/" : url.pathname)) ||
           (await cache.match("/index.html")) ||
           new Response("你而家冇網絡，而且呢一版未 cache 過。", {
             status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
           });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isSupabaseData(url)) return;                       // always live
  if (req.mode === "navigate") return e.respondWith(navigate(req));
  if (isStoredPhoto(url)) return e.respondWith(cacheFirst(req, PHOTOS));
  if (isFontOrLib(url)) return e.respondWith(staleWhileRevalidate(req, ASSETS));
  if (url.origin === self.location.origin) return e.respondWith(staleWhileRevalidate(req, ASSETS));
});
