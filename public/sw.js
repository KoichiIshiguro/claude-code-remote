'use strict';

// IMPORTANT: bump this whenever you change strategy, so old SW caches are wiped.
const CACHE = 'claude-code-v3';
const PRECACHE = ['/icons/icon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Bypass SW entirely for dynamic endpoints.
  if (url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/upload') ||
      e.request.method !== 'GET') return;

  // Network-first: always try the network, fall back to cache only when offline.
  // This means deployed changes show up on the next request, not the one after.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && res.type !== 'opaque') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
