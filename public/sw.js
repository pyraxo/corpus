// Corpus service worker: installable app shell, offline reading, fast repeat loads.
// Never caches the API, chat, MCP or the sign-in page.
const VERSION = 'corpus-v19';
const SHELL = ['/', '/app.js?v=18', '/dropdown.js?v=18', '/styles.css?v=18', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];
const SHELL_CACHE = `${VERSION}-shell`, DATA_CACHE = 'corpus-data', MEDIA_CACHE = 'corpus-media';
const MEDIA_MAX = 400;
// A stalled request must never wedge install or leave the app blank on a bad connection.
const timed = (req, ms, opts = {}) => fetch(req, { ...opts, signal: AbortSignal.timeout(ms) });

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Only cache the shell when signed in (a signed-out "/" is the password page).
    for (const url of SHELL) {
      try { const res = await timed(url, 8000, { credentials: 'include' }); if (res.ok && res.headers.get('x-corpus-page') !== 'login') await cache.put(url, res); } catch {}
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data !== 'cache-shell') return;
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const url of SHELL) { if (await cache.match(url)) continue; try { const res = await timed(url, 8000, { credentials: 'include' }); if (res.ok && res.headers.get('x-corpus-page') !== 'login') await cache.put(url, res); } catch {} }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.endsWith('-shell') && key !== SHELL_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

const networkFirst = async (request, cacheName, { cacheIf = (r) => r.ok, timeout = 15000 } = {}) => {
  const cache = await caches.open(cacheName);
  try {
    const res = await timed(request, timeout);
    if (cacheIf(res)) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    throw new Error('offline');
  }
};

const staleWhileRevalidate = async (request, cacheName, max) => {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = timed(request, 15000).then(res => { if (res.ok || res.type === 'opaque') { cache.put(request, res.clone()); if (max) trim(cacheName, max); } return res; }).catch(() => hit);
  return hit || refresh;
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  if (same && (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname === '/health' || url.pathname === '/sw.js')) return;

  // Pages: always try the network (fresh app, correct sign-in state); fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, { cacheIf: (r) => r.ok && r.headers.get('x-corpus-page') === 'app', timeout: 4000 }).then(async (res) => res, async () => (await caches.match('/', { cacheName: SHELL_CACHE })) || Response.error()));
    return;
  }
  // The bookmark index: network first so it's current, cached for offline reading.
  if (same && url.pathname.startsWith('/data/')) { event.respondWith(networkFirst(req, DATA_CACHE)); return; }
  // App code and styles are versioned by query string.
  if (same) { event.respondWith(staleWhileRevalidate(req, SHELL_CACHE)); return; }
  // Fonts and tweet media.
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { event.respondWith(staleWhileRevalidate(req, MEDIA_CACHE)); return; }
  if (/(^|\.)twimg\.com$/.test(url.hostname) && !/video\.twimg/.test(url.hostname)) { event.respondWith(staleWhileRevalidate(req, MEDIA_CACHE, MEDIA_MAX)); return; }
});
