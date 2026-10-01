// Music Sync Service Worker
const CACHE_NAME = 'sangeetx';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip WebSocket and Socket.IO requests
  const url = event.request.url;
  if (url.includes('/socket.io/')) return;
  if (url.includes('stun:') || url.includes('turn:')) return;
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200) return response;
        
        // Clone response for cache
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone).catch(() => {});
        });
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Return a simple offline page or error
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});

// Keep service worker active for background playback
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'KEEP_ALIVE') {
    event.waitUntil(Promise.resolve());
  }
});