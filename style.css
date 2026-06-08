/**
 * MindLink - Service Worker v31
 * PWAのオフラインキャッシュ（Vercel最適化版）
 */

const CACHE_NAME = 'mindlink-v33';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/config.js',
  '/js/storage.js',
  '/js/crypto.js',
  '/js/auth.js',
  '/js/api.js',
  '/js/threads.js',
  '/js/memory.js',
  '/js/personas.js',
  '/js/chat.js',
  '/js/app.js',
  '/js/google-auth.js',
  '/js/google-services.js',
  '/js/rag.js',
  '/js/reflection.js',
  '/js/spotify-auth.js',
  '/js/spotify.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // APIリクエストはキャッシュしない
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('google.com')) {
    return;
  }
  // Spotify APIリクエストはキャッシュしない
  if (url.hostname.includes('spotify.com') || url.hostname.includes('accounts.spotify.com')) {
    return;
  }

  // OAuthコールバック（?code=）はキャッシュしない（リダイレクトURIの不一致防止）
  if (url.searchParams.has('code') || url.searchParams.has('error')) {
    return;
  }

  // 外部CDNはネットワーク優先（キャッシュしない）
  if (url.origin !== self.location.origin) {
    return;
  }

  // ネットワーク優先戦略: 常に最新を取得、失敗時のみキャッシュを使用
  e.respondWith(
    fetch(e.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(e.request).then(cached => cached || caches.match('/'));
    })
  );
});
