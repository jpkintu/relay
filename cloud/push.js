// Web Push: notifications on the phone's lock screen, even with the app
// closed. Each browser that turns notifications on registers a
// PushSubscription; every in-app notification is also pushed to the
// recipient's subscriptions (see notifyUsers in notifications.js).
//
// The VAPID key pair is created on first use and kept in the private Secret
// class, so there is nothing to configure on Back4App.

const webpush = require('web-push');
const { MASTER, invalid, requireUser, findAll } = require('./lib/core');

// Browser push services. Subscriptions pointing anywhere else are refused so
// the server cannot be used to call arbitrary URLs.
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];
const CONTACT = process.env.RELAY_PUSH_CONTACT || 'https://github.com/jpkintu/relay';
const SEND_TIMEOUT_MS = 5000;

function allowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // e2e tests point subscriptions at a local fake push service.
  const testHosts = (process.env.RELAY_PUSH_TEST_HOSTS || '').split(',').filter(Boolean);
  if (testHosts.includes(url.host)) return true;
  return (
    url.protocol === 'https:' &&
    PUSH_HOST_SUFFIXES.some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  );
}

let cachedKeys = null;
async function vapidKeys() {
  if (cachedKeys) return cachedKeys;
  const find = () => {
    const query = new Parse.Query('Secret');
    query.equalTo('key', 'vapid');
    query.ascending('createdAt');
    return query.first(MASTER);
  };
  let row = await find();
  if (!row) {
    const created = new Parse.Object('Secret');
    created.set({ key: 'vapid', value: webpush.generateVAPIDKeys() });
    created.setACL(new Parse.ACL());
    await created.save(null, MASTER);
    // If two requests raced, both use the earliest key pair.
    row = await find();
  }
  cachedKeys = row.get('value');
  return cachedKeys;
}

Parse.Cloud.define('getPushConfig', async (request) => {
  requireUser(request);
  return { publicKey: (await vapidKeys()).publicKey };
});

// Registers (or moves) this browser's subscription to the signed-in user.
Parse.Cloud.define('savePushSubscription', async (request) => {
  const user = requireUser(request);
  const sub = request.params.subscription || {};
  const endpoint = String(sub.endpoint || '');
  const p256dh = String(sub.keys?.p256dh || '');
  const auth = String(sub.keys?.auth || '');
  if (!allowedEndpoint(endpoint)) throw invalid('Unsupported push service');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth))
    throw invalid('Invalid push subscription keys');
  const query = new Parse.Query('PushSubscription');
  query.equalTo('endpoint', endpoint);
  const row = (await query.first(MASTER)) || new Parse.Object('PushSubscription');
  row.set({
    user: Parse.User.createWithoutData(user.id),
    endpoint,
    p256dh,
    auth,
    userAgent: String(request.params.userAgent || '').slice(0, 200),
    lastSeenAt: new Date(),
  });
  row.setACL(new Parse.ACL());
  await row.save(null, MASTER);
  return { ok: true };
});

// Called when the user turns notifications off or signs out on this device.
Parse.Cloud.define('removePushSubscription', async (request) => {
  const user = requireUser(request);
  const query = new Parse.Query('PushSubscription');
  query.equalTo('endpoint', String(request.params.endpoint || ''));
  query.equalTo('user', user);
  const row = await query.first(MASTER);
  if (row) await row.destroy(MASTER);
  return { ok: !!row };
});

// Push statuses that mean the subscription can never work again: gone (404,
// 410), or made for another key (403 "VAPID credentials do not match").
const DEAD = [403, 404, 410];

// A short name for a device from its browser's user agent.
function deviceName(userAgent = '') {
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iPhone / iPad'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS/.test(userAgent)
          ? 'Mac'
          : 'Device';
  const browser = /SamsungBrowser/.test(userAgent)
    ? 'Samsung Internet'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Firefox/.test(userAgent)
        ? 'Firefox'
        : /Chrome/.test(userAgent)
          ? 'Chrome'
          : /Safari/.test(userAgent)
            ? 'Safari'
            : 'browser';
  return `${os} · ${browser}`;
}

// Sends one payload to each subscription, records how it went on the
// subscription (lastSuccessAt / lastError) and drops dead ones. Never throws.
async function sendToSubscriptions(subs, payloadFor) {
  const keys = await vapidKeys();
  const options = {
    vapidDetails: { subject: CONTACT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 6 * 3600,
    timeout: SEND_TIMEOUT_MS,
  };
  return Promise.all(
    subs.map(async (sub) => {
      const payload = payloadFor(sub);
      const device = deviceName(sub.get('userAgent'));
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.get('endpoint'),
            keys: { p256dh: sub.get('p256dh'), auth: sub.get('auth') },
          },
          JSON.stringify(payload),
          // "high" wakes a sleeping phone straight away.
          { ...options, urgency: payload.tone === 'update' ? 'normal' : 'high' },
        );
        sub.set({ lastSuccessAt: new Date(), lastError: '' });
        await sub.save(null, MASTER).catch(() => undefined);
        return { device, ok: true, problem: '' };
      } catch (error) {
        const status = error?.statusCode || 0;
        const problem = status
          ? `The push service answered ${status}${error.body ? `: ${String(error.body).slice(0, 120)}` : ''}`
          : `Could not reach the push service (${error?.code || error?.message || 'network error'})`;
        if (DEAD.includes(status)) await sub.destroy(MASTER).catch(() => undefined);
        else {
          sub.set({ lastError: problem.slice(0, 200), lastErrorAt: new Date() });
          await sub.save(null, MASTER).catch(() => undefined);
          console.error('push not delivered:', problem);
        }
        return {
          device,
          ok: false,
          problem: DEAD.includes(status)
            ? `${problem}. This device's registration was out of date and has been removed; opening Relay on it registers it again.`
            : problem,
        };
      }
    }),
  );
}

// Sends each saved notification to its recipient's devices. Never throws.
// rows: saved Notification objects.
async function pushNotifications(rows) {
  try {
    if (!rows.length) return 0;
    const byUser = new Map();
    for (const row of rows) byUser.set(row.get('recipient').id, row);
    const query = new Parse.Query('PushSubscription');
    query.containedIn(
      'user',
      [...byUser.keys()].map((id) => Parse.User.createWithoutData(id)),
    );
    const subs = await findAll(query);
    if (!subs.length) return 0;
    const results = await sendToSubscriptions(subs, (sub) => {
      const row = byUser.get(sub.get('user').id);
      return {
        id: row.id,
        title: row.get('title'),
        body: row.get('body'),
        link: row.get('link'),
        tone: row.get('tone'),
      };
    });
    return results.filter((r) => r.ok).length;
  } catch (error) {
    console.error('push failed', error);
    return 0;
  }
}

// Anyone signed in: send a test notification to their own devices and say,
// per device, whether the push service accepted it.
Parse.Cloud.define('sendTestPush', async (request) => {
  const user = requireUser(request);
  const subs = await findAll(new Parse.Query('PushSubscription').equalTo('user', user));
  if (!subs.length) return { sent: 0, failed: 0, devices: [] };
  const devices = await sendToSubscriptions(subs, () => ({
    id: `test-${Date.now()}`,
    title: 'Relay test notification',
    body: 'Notifications work on this device.',
    link: '/',
    tone: 'new',
    // Shown even while Relay is open on screen.
    force: true,
  }));
  return {
    sent: devices.filter((d) => d.ok).length,
    failed: devices.filter((d) => !d.ok).length,
    devices,
  };
});

module.exports = { pushNotifications, allowedEndpoint, deviceName };
