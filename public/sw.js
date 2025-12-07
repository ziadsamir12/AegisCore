// sw.js

self.addEventListener('install', (event) => {
  console.log('[SW] Installed');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activated');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'AegisCore Alert', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'AegisCore Alert';
  const options = {
    body: data.body || 'New security event.',
    icon: '/Gemini_Generated_Image_kevgvmkevgvmkevg.png',
    badge: '/Gemini_Generated_Image_kevgvmkevg.png',
    tag: 'aegiscore-alert'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
