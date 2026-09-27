// Phone / lock-screen notifications (Web Push).
//
// Android (Chrome, Edge, Samsung Internet, Firefox) and desktop browsers
// support it straight from the browser. iPhone and iPad only allow it once
// Relay is added to the Home Screen (Share → Add to Home Screen, iOS 16.4+)
// and opened from that icon.

import Parse from '../parse';

export type PushState =
  | 'on' // this device receives notifications
  | 'off' // supported, not turned on yet
  | 'blocked' // the user blocked notifications for this site
  | 'install' // iPhone/iPad: add to Home Screen first
  | 'unsupported';

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

async function subscription() {
  if (!supported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission === 'granted' && (await subscription())) return 'on';
  return 'off';
}

function keyBytes(base64url: string): Uint8Array {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`;
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function save(sub: PushSubscription) {
  await Parse.Cloud.run('savePushSubscription', {
    subscription: sub.toJSON(),
    userAgent: navigator.userAgent,
  });
}

const base64url = (buffer: ArrayBuffer | null | undefined) =>
  buffer
    ? btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : '';

// Makes sure this device has a working subscription for the server's current
// key, and that it is registered to the signed-in user. A subscription made
// for an older key is rejected by the push service, so it is replaced.
// Needs notification permission already granted (no tap required then).
async function subscribeAndSave(): Promise<PushState> {
  const registration =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { publicKey } = await Parse.Cloud.run('getPushConfig');
  let sub = await registration.pushManager.getSubscription();
  if (sub && base64url(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey) as BufferSource,
  });
  await save(sub);
  return 'on';
}

// Asks for permission (must run from a tap) and registers this device.
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return pushState();
  return subscribeAndSave();
}

// On every start and after sign-in: if notifications are allowed on this
// device, (re)register it for the signed-in user, so they keep working after
// signing out and in, a new phone user, or a key change on the server.
export async function refreshPush() {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    await subscribeAndSave();
  } catch {
    // Offline or push service unreachable: tried again next start.
  }
}

// Before sign-out: stop sending this user's notifications to this device.
// The browser keeps its subscription, so the next person to sign in on this
// device gets notifications without turning them on again.
export async function forgetPush() {
  try {
    const sub = await subscription();
    if (!sub) return;
    await Parse.Cloud.run('removePushSubscription', { endpoint: sub.endpoint });
  } catch {
    // Signed out already or offline; the server drops dead subscriptions.
  }
}

export type TestResult = {
  sent: number;
  failed: number;
  devices: { device: string; ok: boolean; problem: string }[];
};

// Sends a test notification to this user's devices (shown even if Relay is open).
export async function sendTestPush(): Promise<TestResult> {
  await refreshPush();
  return Parse.Cloud.run('sendTestPush');
}
