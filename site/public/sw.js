// openroles Service Worker — Phase 14 step 4.
//
// Purpose: zero-bandwidth revisits for the slim-index chunks.
//
// Strategy:
//   - data/manifest.json → network-first, fall back to cache. The
//     manifest is the only mutable URL we ship; revalidating it on
//     every visit picks up daily refreshes within seconds.
//   - data/slim/slim-NNNN-<sha>.json.gz → cache-first, immutable
//     forever. Filenames are content-hashed so a content change
//     yields a new URL, which the manifest then points to. Old
//     chunks stay cached but are never requested again — they get
//     evicted naturally when the cache fills (max-entries cap below).
//   - data/views/*.json → cache-first, content-hashed. (Reserved for
//     future pre-rendered query results.)
//   - sqlite-vfs/* and SQLite chunks → not cached here; sql.js-httpvfs
//     manages its own range-request cache and the chunks are huge.
//   - Everything else (HTML, JS bundles, CSS) → network-first; let
//     the browser's HTTP cache + Pages's Cache-Control: max-age=600
//     handle freshness. Astro emits content-hashed bundle filenames
//     so a deploy invalidates them anyway.
//
// Cache name versioned via SW_VERSION so a SW change blows the cache;
// updating the version is the kill switch if something gets stuck.

const SW_VERSION = "v1";
const CACHE_NAME = `openroles-slim-index-${SW_VERSION}`;
const MAX_CHUNK_ENTRIES = 64; // ≈ ~150 MB worst case at our chunk sizes
const SLIM_CHUNK_RE = /\/data\/slim\/slim-\d{4}-[0-9a-f]{16}\.json\.gz$/;
const SLIM_VIEW_RE = /\/data\/views\/[^/]+\.json$/;
const MANIFEST_RE = /\/data\/manifest\.json$/;

self.addEventListener("install", () => {
  // Activate immediately on install so the new SW takes over without
  // a tab refresh — keeps deploys snappy.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("openroles-slim-index-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (MANIFEST_RE.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (SLIM_CHUNK_RE.test(url.pathname) || SLIM_VIEW_RE.test(url.pathname)) {
    event.respondWith(cacheFirstImmutable(req));
    return;
  }
  // Everything else falls through to the browser's default networking.
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstImmutable(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh.ok) {
    cache.put(req, fresh.clone());
    // Best-effort eviction: if we have more than MAX_CHUNK_ENTRIES
    // chunk entries cached, drop the oldest. caches.keys() returns
    // entries in insertion order so the head is the LRU candidate.
    enforceCacheCap(cache).catch(() => {
      // Eviction is opportunistic; ignore failures (e.g. storage quota).
    });
  }
  return fresh;
}

async function enforceCacheCap(cache) {
  const keys = await cache.keys();
  const chunks = keys.filter((k) => SLIM_CHUNK_RE.test(new URL(k.url).pathname));
  if (chunks.length <= MAX_CHUNK_ENTRIES) return;
  const drop = chunks.slice(0, chunks.length - MAX_CHUNK_ENTRIES);
  await Promise.all(drop.map((k) => cache.delete(k)));
}
