const CACHE_NAME = 'daway-sudan-v2';

// قائمة الملفات الأساسية
const urlsToCache = [
  './',
  './index.html',
  './login.html',
  './profile.html',
  './addph.html',
  './daway.html',
  './reg.html',
  './style.css',
  './script.js',
  './manifest.json',
  '/offline.html',
  '/images/daway_sudan_logo.png',
  '/images/icons/offline-icon.png',
  '/images/icons/icon-192x192.png',
  'https://unpkg.com/lucide@latest',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore-compat.js'
];

// التثبيت
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// التفعيل
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// الجلب
self.addEventListener('fetch', event => {
  if (
    event.request.url.includes('firestore.googleapis.com') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }
      return fetch(event.request)
        .then(networkResponse => {
          return networkResponse;
        })
        .catch(() => caches.match('/offline.html'));
    })
  );
});