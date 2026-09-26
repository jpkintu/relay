import { useState } from 'react';
import { BellRing, Share, X } from 'lucide-react';
import { useNotifications } from '../lib/notifications';

const DISMISS_KEY = 'relay:push-prompt-dismissed';

// Asks to turn on notifications for this device (phone, tablet or computer). `card` is the
// prominent version for the rider home and kitchen board; the compact one
// sits in the notifications panel.
export function PushPrompt({ card = false }: { card?: boolean }) {
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!notifications) return null;
  const { push, enablePhoneNotifications } = notifications;
  if (push === 'unsupported') return null;

  if (card && (push === 'on' || dismissed)) return null;

  if (push === 'on')
    return (
      <p className="push-state on">
        <BellRing aria-hidden /> Notifications are on for this device
      </p>
    );
  if (push === 'blocked')
    return (
      <p className="push-state">
        Notifications are blocked. Allow them for this site in the browser settings.
      </p>
    );

  const body =
    push === 'install' ? (
      <span>
        On iPhone or iPad: tap <Share aria-label="Share" className="inline-icon" /> Share →{' '}
        <b>Add to Home Screen</b>, then open Relay from the new icon and turn notifications on.
      </span>
    ) : (
      <span>
        Get new orders and updates as they happen, even when Relay is closed or the screen is
        locked.
      </span>
    );

  return (
    <div className={card ? 'push-prompt card' : 'push-prompt'}>
      {card && <BellRing aria-hidden className="push-prompt-icon" />}
      <div>
        {card && <strong>Turn on notifications on this device</strong>}
        {body}
      </div>
      {push === 'off' && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await enablePhoneNotifications();
            setBusy(false);
          }}
        >
          {busy ? 'Turning on…' : card ? 'Turn on' : 'Turn on notifications on this device'}
        </button>
      )}
      {card && (
        <button
          className="push-dismiss"
          aria-label="Not now"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {
              // Private mode: hidden for this visit only.
            }
          }}
        >
          <X />
        </button>
      )}
    </div>
  );
}
