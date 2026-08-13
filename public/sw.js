/* NewzWale service worker — P9.
 *
 * Served verbatim from public/; it is NOT bundled, so this is a classic
 * (non-module) script with no imports. Safari's module-worker support is not
 * good enough to rely on, and the file is small enough not to need bundling.
 *
 * THE FOOTGUN THIS FILE IS BUILT AROUND
 * ------------------------------------
 * NEWZWALE_IMPLEMENTATION_PLAN.md §Phase 9: "A buggy service worker can serve
 * stale content permanently." Everything below follows from that:
 *
 *   - Nothing is cached by a wildcard. route() is an explicit allowlist and
 *     returns 'bypass' for anything it does not positively recognise, so a new
 *     route added elsewhere in the app is un-cached until someone edits THIS
 *     file on purpose.
 *   - HTML is network-first. The cache is a fallback for a failed network, not
 *     a source of truth.
 *   - /api/* is NEVER cached, in either direction. Fact-check verdicts, the
 *     weather lookup and every user-triggered request go straight to the
 *     network. A cached verdict is a wrong verdict.
 *   - /fact-check/* is 'fresh': network-only, falling back to the offline page
 *     rather than to a stale verdict. The product's whole claim is that a
 *     verdict reflects the evidence fetched for it; showing yesterday's from a
 *     cache would break that quietly, which is the worst way to break it.
 *   - Only same-origin GETs are ever stored, and canCache() re-checks the
 *     response before it goes in.
 *
 * KILL SWITCH — see §Rollback ("Unregister the service worker and serve an
 * empty sw.js. Test this path BEFORE shipping"). Flip KILL_SWITCH to true and
 * deploy: this worker then deletes every cache, unregisters itself, reloads
 * open clients, and installs no fetch handler at all, so the origin returns to
 * plain network behaviour. There is no remote flag to poll, because Phase 9's
 * "API: None" rules one out; the trigger is a deploy.
 */

/** Bump on every change to the caching rules or the precache list. Old caches
 *  are deleted in activate, so a bump is also a full cache flush. */
const VERSION = 'v1';

/** Set to true and deploy to disable the service worker for every visitor. */
const KILL_SWITCH = false;

const STATIC_CACHE = `nz-static-${VERSION}`;
const PAGE_CACHE = `nz-pages-${VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, PAGE_CACHE];

/** Trailing slash is load-bearing. Prerendered routes build to
 *  `dist/client/offline/index.html`, and Workers Assets 307s `/offline` to
 *  `/offline/`. Precaching the un-slashed form would store a redirect, and a
 *  redirected response cannot satisfy a navigation via respondWith. */
const OFFLINE_URL = '/offline/';

/** Cap on cached HTML documents. Without it, a long browsing session stores
 *  every page ever visited. Oldest-first eviction; Cache.keys() is insertion
 *  ordered. */
const MAX_PAGES = 40;

/** Build output and self-hosted fonts only. Both are content-addressed or
 *  effectively immutable, which is the only reason cache-first is safe here. */
const STATIC_PREFIXES = ['/_astro/', '/fonts/'];
const STATIC_FILES = new Set([
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-96x96.png',
  '/apple-touch-icon.png',
  '/logo.png',
  '/site.webmanifest',
  '/web-app-manifest-192x192.png',
  '/web-app-manifest-512x512.png',
]);

/**
 * The whole caching policy, as one pure function so it can be unit-tested
 * without a browser (see tests/pwa/sw.test.ts).
 *
 * @param {string} rawUrl   absolute request URL
 * @param {string} method   HTTP method
 * @param {string} mode     Request.mode ('navigate' for document loads)
 * @returns {'bypass'|'static'|'page'|'fresh'}
 */
function route(rawUrl, method, mode) {
  // Only GET is ever cacheable. POST /api/v1/factcheck must never be touched.
  if (method !== 'GET') return 'bypass';

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'bypass';
  }

  // Cross-origin: publisher thumbnails, Google Analytics, googletagmanager.
  // Caching another origin's bytes is both a privacy and a poisoning problem.
  if (url.origin !== self.location.origin) return 'bypass';

  const path = url.pathname;

  // Never cache the API. Not the fact-check endpoints, not /api/v1/weather
  // (which is derived from the visitor's own request.cf), not the ticker.
  if (path === '/api' || path.startsWith('/api/')) return 'bypass';

  // The one fact-check route carrying no server-rendered verdict: /fact-check/
  // history is a prerendered shell that reads the visitor's own localStorage.
  // Caching the shell makes a device-local record readable offline without any
  // verdict ever entering a cache.
  if (path === '/fact-check/history' || path === '/fact-check/history/') return 'page';

  // Verdicts must be fetched, not recalled.
  if (path === '/fact-check' || path.startsWith('/fact-check/')) return 'fresh';

  if (STATIC_FILES.has(path)) return 'static';
  if (STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'static';

  // Everything else is cacheable only as a document. A same-origin fetch() of
  // some future endpoint falls through to 'bypass' rather than being guessed at.
  if (mode === 'navigate') return 'page';

  return 'bypass';
}

/**
 * Second gate: even an allowlisted URL only enters a cache if the RESPONSE
 * says it may. Guards against storing redirects, opaque responses, error
 * pages, and anything the server marked private or no-store.
 *
 * @param {Response} response
 * @returns {boolean}
 */
function canCache(response) {
  if (!response || !response.ok || response.status !== 200) return false;
  // 'basic' is same-origin; 'default' is what a synthesised Response reports.
  if (response.type && response.type !== 'basic' && response.type !== 'default') return false;
  if (response.redirected) return false;
  const cc = (response.headers && response.headers.get('cache-control')) || '';
  if (/no-store|private/i.test(cc)) return false;
  return true;
}

// Exposed for the unit tests, which load this file in a VM with a stubbed
// `self`. Harmless in a real worker: `self` is not reachable from a page.
self.__nz = { route, canCache, VERSION, CURRENT_CACHES, OFFLINE_URL, MAX_PAGES };

if (KILL_SWITCH) {
  // The documented rollback path. No fetch listener is registered at all, so
  // every request goes to the network even before unregistration completes.
  self.addEventListener('install', () => self.skipWaiting());

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.navigate(client.url);
      })(),
    );
  });
} else {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        const res = await fetch(OFFLINE_URL, { cache: 'reload' });
        // Re-wrapped rather than stored directly: if the fetch followed a
        // redirect, `res.redirected` is true and the browser refuses to use it
        // for a navigation. A fresh Response carries the same bytes with a
        // clean redirect flag.
        await cache.put(
          OFFLINE_URL,
          new Response(await res.blob(), { status: 200, headers: res.headers }),
        );
        // Take over immediately rather than waiting for every tab to close.
        // Paired with clients.claim() below, this is what stops a bad version
        // from persisting "indefinitely" (§Phase 9 Tests).
        await self.skipWaiting();
      })(),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          names.filter((name) => !CURRENT_CACHES.includes(name)).map((name) => caches.delete(name)),
        );
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener('fetch', (event) => {
    const decision = route(event.request.url, event.request.method, event.request.mode);
    if (decision === 'bypass') return; // Untouched: the browser handles it.

    if (decision === 'static') {
      event.respondWith(cacheFirst(event.request));
    } else if (decision === 'page') {
      event.respondWith(networkFirst(event.request));
    } else {
      event.respondWith(networkOnly(event.request));
    }
  });
}

/** Immutable build assets: cache, then network on a miss. */
async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (canCache(response)) await cache.put(request, response.clone());
  return response;
}

/** HTML: always try the network first; the cache is the offline fallback. */
async function networkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (canCache(response)) {
      await cache.put(request, response.clone());
      await trim(PAGE_CACHE, MAX_PAGES);
    }
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw new Error('offline');
  }
}

/** Fact-check routes: network, or the offline page. Never a stale verdict. */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(PAGE_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw new Error('offline');
  }
}

/** Oldest-first eviction. The offline page is re-added by install on the next
 *  version bump, and is protected here because it is never the oldest entry
 *  for long enough to matter — it is written before any page is browsed. */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - max;
  for (let i = 0; i < excess; i++) {
    const key = keys[i];
    if (new URL(key.url).pathname === OFFLINE_URL) continue;
    await cache.delete(key);
  }
}
