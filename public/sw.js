// Service Worker · X Reader
// 网络优先：保证刷新/PWA 重开时拿到最新前端，离线时才回退缓存。
const CACHE = 'x-reader-v3';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.destination === 'audio') return;

  // 页面与静态资源都网络优先；请求成功时更新缓存，断网才用旧版本。
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok && event.request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('/')))
  );
});
