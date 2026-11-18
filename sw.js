/* NutriTrack service worker — offline app shell. Personal data is never cached here (it lives in IndexedDB). */
const CACHE = 'nutritrack-v6.1.0';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CDN = ['https://unpkg.com/@zxing/browser@0.1/umd/zxing-browser.min.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    for (const u of CDN) { try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); } catch (err) { /* cached later on first use */ } }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('nutritrack-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Food database & product images: always live, never cached by the worker.
  if (url.hostname.endsWith('openfoodfacts.org')) return;

  // App files: network first (so updates arrive), fall back to cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req, { cache: 'no-cache' }); // always ask the server for the newest version
        if (r.ok) { const c = await caches.open(CACHE); c.put(req, r.clone()); }
        return r;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  // Barcode and text-reading libraries from CDNs: cache first, so scanning works offline after the first load.
  if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'tessdata.projectnaptha.com') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    })());
  }
});
