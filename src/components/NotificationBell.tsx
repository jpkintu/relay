import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, Volume2, VolumeX } from 'lucide-react';
import { useNotifications } from '../lib/notifications';
import { timeAgo } from '../lib/format';

// Bell with the unread count; opens the list of notifications.
export function NotificationBell() {
  const notifications = useNotifications();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) =>
      !wrapper.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!notifications) return null;
  const { items, unread, soundOn, setSoundOn, alertsPermission, enableAlerts } = notifications;
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div className="bell" ref={wrapper}>
      <button
        className="icon-button bell-button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {unread ? <BellRing /> : <Bell />}
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section className="bell-panel" role="dialog" aria-label="Notifications">
          <header>
            <h2>Notifications</h2>
            {unread > 0 && (
              <button className="link-button" onClick={() => void notifications.markAllRead()}>
                Mark all read
              </button>
            )}
          </header>
          <ul>
            {items.map((n) => (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <button
                  onClick={() => {
                    void notifications.markRead([n.id]);
                    if (n.link) {
                      setOpen(false);
                      navigate(n.link);
                    }
                  }}
                >
                  <span className={`bell-dot ${n.tone}`} aria-hidden />
                  <span className="bell-text">
                    <strong>{n.title}</strong>
                    {n.body && <span>{n.body}</span>}
                    <small>{timeAgo(n.createdAt)}</small>
                  </span>
                </button>
              </li>
            ))}
            {!items.length && <li className="bell-empty">Nothing yet.</li>}
          </ul>
          <footer>
            <button onClick={() => setSoundOn(!soundOn)} aria-pressed={soundOn}>
              {soundOn ? <Volume2 /> : <VolumeX />}
              {soundOn ? 'Sound on' : 'Sound off'}
            </button>
            {alertsPermission === 'default' && (
              <button onClick={() => void enableAlerts()}>
                <BellRing />
                Allow alerts in the background
              </button>
            )}
            {alertsPermission === 'denied' && (
              <small>Phone alerts are blocked in the browser settings.</small>
            )}
          </footer>
        </section>
      )}
    </div>
  );
}
