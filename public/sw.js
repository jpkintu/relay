// Relay service worker: shows push notifications on the lock screen and
// opens the right screen when one is tapped. Push messages come from Cloud
// Code (cloud/push.js) as JSON: { id, title, body, link, tone }.
//
// It also keeps an offline shell: the app's page, scripts, styles, fonts and
// icons are cached so Relay opens (and shows what it last loaded) without a
// connection. Pages are fetched from the network first, so a new deploy is
// picked up on the next load; built assets have hashed names and never change.
// Data (the Parse API) is never cached here.

// v4: drops caches that may hold an HTML page stored as a script (see keep).
const SHELL = 'relay-shell-v4';
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

// Only real files are kept. Some hosts answer a missing file with the app's
// page (status 200); kept as a script, that page would break every later
// load of it (e.g. the charts after a deploy), so it is never stored.
const EXPECTED = { js: /javascript/, css: /css/, woff2: /font|octet/, woff: /font|octet/ };
function keep(url, response) {
  if (!response || !response.ok) return false;
  const type = response.headers.get('content-type') || '';
  const ext = new URL(url, self.location.origin).pathname.split('.').pop();
  if (EXPECTED[ext]) return EXPECTED[ext].test(type);
  return !/text\/html/.test(type) || url === '/';
}

async function store(cache, url) {
  const response = await fetch(url);
  if (keep(url, response)) await cache.put(url, response);
}

// Caches the page and the scripts and styles it loads, so the very next
// start works offline even if this visit was the first.
async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(PRECACHE.map((url) => store(cache, url).catch(() => undefined)));
  const page = await cache.match('/');
  const html = page ? await page.text() : '';
  const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) || [])];
  await Promise.all(assets.map((asset) => store(cache, asset).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put('/', response.clone());
      // A new deploy: fetch its scripts and styles in the background.
      response
        .clone()
        .text()
        .then((html) => {
          const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) || [])];
          return Promise.all(
            assets.map((asset) =>
              cache
                .match(asset, { ignoreVary: true })
                .then((hit) => hit || store(cache, asset).catch(() => undefined)),
            ),
          );
        })
        .catch(() => undefined);
    }
    return response;
  } catch {
    return (await cache.match('/', { ignoreVary: true })) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  // Scripts load in CORS mode (with an Origin header) and hosts send
  // "Vary: Origin", so match on the URL alone.
  const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
  if (cached && keep(request.url, cached)) return cached;
  if (cached) await cache.delete(request, { ignoreVary: true });
  const response = await fetch(request);
  if (keep(request.url, response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/parse')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (/^\/(assets|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest')
    event.respondWith(cacheFirst(request));
});

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
      // (A test notification is always shown.)
      if (
        !data.force &&
        windows.some((client) => client.focused && client.visibilityState === 'visible')
      )
        return;
      try {
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
        // Tell the app the banner was handed to the system (for the test button).
        for (const client of windows) client.postMessage({ type: 'relay:push-shown', id: data.id });
      } catch (error) {
        for (const client of windows)
          client.postMessage({ type: 'relay:push-error', id: data.id, message: String(error) });
      }
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
