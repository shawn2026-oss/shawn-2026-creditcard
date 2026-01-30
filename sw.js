const CACHE_VERSION = 'v125.5';
const CACHE_NAME = `creditcard-${CACHE_VERSION}`;

// 安裝時快取檔案
self.addEventListener('install', event => {
    self.skipWaiting();
});

// 啟用時清除舊快取
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// 網路優先策略：優先從網路取得最新版本
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request)
            .then(response => {
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});
