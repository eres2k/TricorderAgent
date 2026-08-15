// Tricorder Service Worker — Network-First strategy
// Always fetches latest from network, falls back to cache when offline.
// Bump CACHE_VERSION on each deploy to bust stale caches.
const CACHE_VERSION = '1786813305849';
const CACHE_NAME = `tricorder-agent-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/llm-tools/registry.js',
  '/js/llm-tools/tool-index.js',
  '/js/llm-tools/web-tools.js',
  '/js/llm-tools/file-tools.js',
  '/js/llm-tools/system-tools.js',
  '/js/llm-tools/code-tools.js',
  '/js/llm-tools/browser-tools.js',
  '/js/llm-tools/task-tools.js',
  '/js/llm-tools/memory-tools.js',
  '/js/llm-tools/agent-tools.js',
  '/js/llm-tools/extended-tools.js',
  '/js/file-fences.js',
  '/js/chat-stream.js',
  '/js/llm.js',
  '/js/audio.js',
  '/js/markdown.js',
  '/js/setup.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// True when the response body is HTML but the request expected something else
// (e.g. a CSS/JS asset). This happens when the server returns the login page or
// the SPA index.html fallback for an asset URL — we must never cache that, or it
// poisons the asset and the browser reports a MIME mismatch on the next load.
function isHtmlForNonHtmlRequest(request, response) {
  const url = new URL(request.url);
  const expectsHtml =
    request.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.webmanifest');
  if (expectsHtml) return false;
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/html');
}

// Install: precache core assets, then activate immediately.
// skipWaiting() is required so Firefox mobile sees an active SW and offers "Install".
// Precache resiliently: fetch each asset individually and only store it if it's a
// genuine, correctly-typed response — a single missing/poisoned URL must not abort
// the whole install (cache.addAll rejects on the first failure).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((u) =>
          fetch(u, { cache: 'no-store' })
            .then((resp) => {
              if (resp.ok && !isHtmlForNonHtmlRequest(new Request(u), resp)) {
                return cache.put(u, resp);
              }
            })
            .catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate: delete ALL old caches, take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for navigation & same-origin requests
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  // Skip API calls — never cache these. /preview/* is a live dev-server
  // preview: caching it would serve a stale page and fight live reload.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/llm/')
      || url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
    return;
  }

  event.respondWith(
    // cache: 'no-store' bypasses the browser's HTTP cache entirely,
    // ensuring we always hit the actual server, not a stale HTTP-cached copy
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        // Only cache successful responses so a transient 404/500 can't poison the
        // cache, and never cache an HTML body returned for a CSS/JS/asset request
        // (login page or SPA fallback) — that would poison the asset.
        if (response.ok && !isHtmlForNonHtmlRequest(request, response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          // Don't serve a previously-poisoned HTML response for an asset request.
          if (cached && isHtmlForNonHtmlRequest(request, cached)) return undefined;
          return cached;
        })
      )
  );
});
