// Service Worker for Push Notifications
// Place this file at public/sw.js in your React project

self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.message || 'New notification from Housify',
    icon: '/logo192.png',
    badge: '/logo192.png',
    data: { url: data.url || '/' },
    actions: data.actions || [],
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Housify', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
