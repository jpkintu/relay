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

// Asks for permission (must run from a tap) and registers this device.
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return pushState();
  const registration =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { publicKey } = await Parse.Cloud.run('getPushConfig');
  const sub =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey) as BufferSource,
    }));
  await save(sub);
  return 'on';
}

// After sign-in: make sure this device's subscription belongs to the
// signed-in user (another person may have used the phone before).
export async function refreshPush() {
  try {
    if (Notification.permission !== 'granted') return;
    const sub = await subscription();
    if (sub) await save(sub);
  } catch {
    // Not supported or offline: nothing to refresh.
  }
}

// Before sign-out: stop sending this user's notifications to this device.
export async function forgetPush() {
  try {
    const sub = await subscription();
    if (!sub) return;
    await Parse.Cloud.run('removePushSubscription', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch {
    // Signed out already or offline; the server drops dead subscriptions.
  }
}
