// Relay service worker: shows push notifications on the lock screen and
// opens the right screen when one is tapped. Push messages come from Cloud
// Code (cloud/push.js) as JSON: { id, title, body, link, tone }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Vibration patterns (ms) per tone; "alert" and "new" are longer and stay on
// screen until tapped so a rider does not miss them.
const VIBRATE = {
  alert: [300, 120, 300, 120, 500],
  new: [250, 100, 250],
  update: [200],
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Relay', body: event.data ? event.data.text() : '' };
  }
  const tone = data.tone || 'update';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Tell open copies of the app to refresh their bell now.
      for (const client of windows) client.postMessage({ type: 'relay:push', data });
      // The app is on screen: it plays its own sound, no system banner needed.
      if (windows.some((client) => client.focused && client.visibilityState === 'visible')) return;
      await self.registration.showNotification(data.title || 'Relay', {
        body: data.body || '',
        tag: data.id || undefined,
        renotify: Boolean(data.id),
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        vibrate: VIBRATE[tone] || VIBRATE.update,
        requireInteraction: tone !== 'update',
        silent: false,
        timestamp: Date.now(),
        data: { link: data.link || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    (async () => {
      const url = new URL(link, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
