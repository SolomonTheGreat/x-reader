// Service Worker · X Reader
// 最小版：只做 App Shell 缓存，不缓存 API 和音频
const CACHE = 'x-reader-v1';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 请求不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 音频不缓存（避免占存储）
  if (e.request.destination === 'audio') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).catch(() => caches.match('/')))
  );
});
