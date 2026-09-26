import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Parse from '../parse';
import { useSession } from './session';
import { playTone, strongestTone, unlockAudio } from './sound';

export type AppNotification = {
  id: string;
  kind: string;
  tone: 'new' | 'update' | 'alert';
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
};

type Notifications = {
  items: AppNotification[];
  unread: number;
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  alertsPermission: NotificationPermission | 'unsupported';
  enableAlerts: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
};

const POLL_MS = 12000;
const SOUND_KEY = 'relay:sound';

const NotificationsContext = createContext<Notifications | null>(null);

const storedSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
};

const permission = (): NotificationPermission | 'unsupported' =>
  typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission
    : 'unsupported';

// Polls the server for the signed-in user's notifications. New ones play a
// sound and, when the app is in the background and alerts are allowed,
// show a system notification.
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user, profile, preview } = useSession();
  const enabled = !!user && !!profile?.role && !preview;
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [soundOn, setSoundState] = useState(storedSound);
  const [alertsPermission, setAlertsPermission] = useState(permission);
  const seen = useRef<Set<string> | null>(null);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const result: { items: AppNotification[]; unread: number } =
        await Parse.Cloud.run('getNotifications');
      setItems(result.items);
      setUnread(result.unread);
      const fresh = seen.current
        ? result.items.filter((n) => !n.read && !seen.current!.has(n.id))
        : [];
      seen.current = new Set(result.items.map((n) => n.id));
      if (!fresh.length) return;
      const tone = strongestTone(fresh.map((n) => n.tone));
      if (tone && soundRef.current) playTone(tone);
      if (document.hidden && permission() === 'granted') {
        for (const n of fresh.slice(0, 3))
          new Notification(n.title, { body: n.body, tag: n.id, icon: '/favicon.ico' });
      }
    } catch {
      // Offline or signed out; try again on the next tick.
    }
  }, [enabled]);

  useEffect(() => {
    seen.current = null;
    setItems([]);
    setUnread(0);
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);

  // Audio may only start after a user gesture.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const setSoundOn = (on: boolean) => {
    setSoundState(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
    if (on) {
      unlockAudio();
      playTone('update');
    }
  };

  const enableAlerts = async () => {
    if (permission() === 'unsupported') return;
    setAlertsPermission(await Notification.requestPermission());
  };

  const markRead = async (ids: string[]) => {
    const unreadIds = ids.filter((id) => items.some((n) => n.id === id && !n.read));
    if (!unreadIds.length) return;
    setItems((list) => list.map((n) => (unreadIds.includes(n.id) ? { ...n, read: true } : n)));
    setUnread((n) => Math.max(0, n - unreadIds.length));
    await Parse.Cloud.run('markNotificationsRead', { ids: unreadIds }).catch(() => undefined);
  };

  const markAllRead = async () => {
    setItems((list) => list.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await Parse.Cloud.run('markNotificationsRead', { all: true }).catch(() => undefined);
  };

  return (
    <NotificationsContext.Provider
      value={{
        items,
        unread,
        soundOn,
        setSoundOn,
        alertsPermission,
        enableAlerts,
        markRead,
        markAllRead,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): Notifications | null {
  return useContext(NotificationsContext);
}
