// ============================================================
// SangeetX — Service Worker
// Offline-first PWA for music sync
// ============================================================

const CACHE_VERSION = 'v2';                          // ⬅️ Version badhao jab bhi update karo
const STATIC_CACHE = `sangeetx-static-${CACHE_VERSION}`;
const SONG_CACHE   = `sangeetx-songs-${CACHE_VERSION}`;
const API_CACHE    = `sangeetx-api-${CACHE_VERSION}`;

// Cache size limits
const MAX_SONGS_CACHED = 30;                          // Max 30 songs offline
const MAX_API_ENTRIES  = 50;

// Static assets — install pe cache honge
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ============================================================
// INSTALL — Static assets cache
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.log('[SW] Some static assets failed to cache:', err);
      });
    })
  );
  
  // Naya SW turant active ho
  self.skipWaiting();
});

// ============================================================
// ACTIVATE — Purane caches clean karo
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((n) => 
            n !== STATIC_CACHE && 
            n !== SONG_CACHE && 
            n !== API_CACHE
          )
          .map((n) => {
            console.log('[SW] Deleting old cache:', n);
            return caches.delete(n);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH — Smart caching strategy
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Only GET requests handle karo
  if (request.method !== 'GET') return;
  
  // ===== SKIP: Socket.io, WebRTC =====
  if (url.pathname.includes('/socket.io/')) return;
  if (url.protocol === 'stun:' || url.protocol === 'turn:') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.protocol === 'blob:') return;
  
  // ===== ROUTE 1: Audio files → Cache First =====
  if (isAudioRequest(request, url)) {
    event.respondWith(handleAudioRequest(request));
    return;
  }
  
  // ===== ROUTE 2: API calls → Network First =====
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }
  
  // ===== ROUTE 3: Images → Cache First (with network fallback) =====
  if (request.destination === 'image' || isImageRequest(url)) {
    event.respondWith(handleImageRequest(request));
    return;
  }
  
  // ===== ROUTE 4: Static assets (HTML/CSS/JS) → Network First =====
  event.respondWith(handleStaticRequest(request));
});

// ============================================================
// HANDLERS
// ============================================================

/**
 * Audio files — Cache First (offline music ke liye)
 */
async function handleAudioRequest(request) {
  try {
    const cache = await caches.open(SONG_CACHE);
    const cached = await cache.match(request);
    
    if (cached) {
      console.log('[SW] 🎵 Audio from cache:', request.url.slice(-50));
      return cached;
    }
    
    // Cache me nahi hai → network se lo
    const response = await fetch(request);
    
    if (response.ok) {
      // Cache me store karo (background me)
      cache.put(request, response.clone()).then(() => {
        trimCache(SONG_CACHE, MAX_SONGS_CACHED);
      }).catch(() => {});
    }
    
    return response;
  } catch (err) {
    // Network fail → cache se try karo
    const cache = await caches.open(SONG_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    
    // Kuch bhi nahi mila
    console.log('[SW] ❌ Audio unavailable offline');
    return new Response('', { 
      status: 503, 
      statusText: 'Audio unavailable offline' 
    });
  }
}

/**
 * API calls — Network First, cache fallback
 */
async function handleApiRequest(request) {
  try {
    const response = await fetch(request);
    
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone()).then(() => {
        trimCache(API_CACHE, MAX_API_ENTRIES);
      }).catch(() => {});
    }
    
    return response;
  } catch (err) {
    // Network fail → cache se try karo
    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(request);
    
    if (cached) {
      console.log('[SW] 📦 API from cache:', request.url);
      return cached;
    }
    
    // JSON error return karo (client handle karega)
    return new Response(
      JSON.stringify({ 
        error: 'Offline', 
        results: [], 
        offline: true 
      }), 
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * Images — Cache First
 */
async function handleImageRequest(request) {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    
    if (cached) return cached;
    
    const response = await fetch(request);
    
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    
    return response;
  } catch (err) {
    // Image fail → placeholder return karo
    return new Response('', { status: 404 });
  }
}

/**
 * Static assets — Network First, cache fallback
 * Navigation requests ke liye index.html fallback
 */
async function handleStaticRequest(request) {
  try {
    const response = await fetch(request);
    
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    
    return response;
  } catch (err) {
    // Network fail → cache
    const cached = await caches.match(request);
    if (cached) return cached;
    
    // Navigation request → index.html fallback
    if (request.mode === 'navigate') {
      const indexCached = await caches.match('/index.html') 
                       || await caches.match('/');
      if (indexCached) return indexCached;
    }
    
    // Kuch bhi nahi mila
    return new Response(
      `<!DOCTYPE html>
      <html>
        <head><title>Offline</title></head>
        <body style="background:#08080C;color:#FAFAFC;font-family:sans-serif;text-align:center;padding:60px 20px;">
          <h1>📴 You're Offline</h1>
          <p>Music Sync needs internet for this action.</p>
          <button onclick="location.reload()" style="background:#8B5CF6;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:16px;margin-top:20px;cursor:pointer;">
            Try Again
          </button>
        </body>
      </html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Check karo audio request hai ya nahi
 */
function isAudioRequest(request, url) {
  // Destination check
  if (request.destination === 'audio') return true;
  
  // File extension check
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.mp3')) return true;
  if (path.endsWith('.m4a')) return true;
  if (path.endsWith('.aac')) return true;
  if (path.endsWith('.ogg')) return true;
  if (path.endsWith('.wav')) return true;
  
  // Saavn / music CDN hosts
  const host = url.hostname.toLowerCase();
  if (host.includes('saavn')) return true;
  if (host.includes('aac')) return true;
  if (host.includes('jiosaavn')) return true;
  if (host.includes('saavncdn')) return true;
  if (host.includes('cloudfront')) return true;
  
  return false;
}

/**
 * Check karo image request hai ya nahi
 */
function isImageRequest(url) {
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.jpg')) return true;
  if (path.endsWith('.jpeg')) return true;
  if (path.endsWith('.png')) return true;
  if (path.endsWith('.webp')) return true;
  if (path.endsWith('.svg')) return true;
  if (path.endsWith('.gif')) return true;
  return false;
}

/**
 * Cache ko size limit me rakho (FIFO)
 */
async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    
    if (keys.length > maxItems) {
      const toDelete = keys.slice(0, keys.length - maxItems);
      await Promise.all(toDelete.map(key => cache.delete(key)));
      console.log(`[SW] Trimmed ${toDelete.length} items from ${cacheName}`);
    }
  } catch (err) {
    console.log('[SW] Trim failed:', err);
  }
}

// ============================================================
// BACKGROUND PLAYBACK KEEP-ALIVE
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'KEEP_ALIVE') {
    event.waitUntil(Promise.resolve());
  }
  
  // Manual cache clear (debugging ke liye)
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(names => 
        Promise.all(names.map(n => caches.delete(n)))
      ).then(() => {
        console.log('[SW] All caches cleared');
        if (event.source) {
          event.source.postMessage({ type: 'CACHE_CLEARED' });
        }
      })
    );
  }
  
  // Cache stats (debugging ke liye)
  if (event.data && event.data.type === 'CACHE_STATS') {
    event.waitUntil(
      Promise.all([
        caches.open(SONG_CACHE).then(c => c.keys()),
        caches.open(STATIC_CACHE).then(c => c.keys()),
        caches.open(API_CACHE).then(c => c.keys())
      ]).then(([songs, statics, apis]) => {
        if (event.source) {
          event.source.postMessage({
            type: 'CACHE_STATS_RESULT',
            songs: songs.length,
            statics: statics.length,
            apis: apis.length,
            songLimit: MAX_SONGS_CACHED
          });
        }
      })
    );
  }
});
