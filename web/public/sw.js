/* Cove service worker — used only for push notifications.
   It deliberately has no fetch handler: nothing (messages, media, API responses) is cached offline. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'Cove', body: 'New message', tag: 'cove', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* keep the generic text */
  }
  event.waitUntil(
    (async () => {
      // Skip the system notification when a Cove tab is already focused.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.some((c) => c.focused && c.visibilityState === 'visible')) return;
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: data.url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          c.postMessage({ type: 'navigate', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
