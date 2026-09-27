import { useEffect, useState } from 'react';

// "Install Relay" (add to home screen). Chrome, Edge and Android fire
// `beforeinstallprompt` once, often before React mounts, so it is caught here
// at startup and kept until the person taps Install. iPhone/iPad have no such
// event: they get the Share → Add to Home Screen hint instead.
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function listenForInstall() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type InstallState = 'installed' | 'available' | 'ios' | 'unavailable';

export function useInstall() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const update = () => setVersion((n) => n + 1);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  const state: InstallState = isInstalled()
    ? 'installed'
    : deferred
      ? 'available'
      : isIos()
        ? 'ios'
        : 'unavailable';
  const install = async () => {
    if (!deferred) return false;
    const event = deferred;
    await event.prompt();
    const { outcome } = await event.userChoice;
    deferred = null;
    notify();
    return outcome === 'accepted';
  };
  return { state, install };
}
