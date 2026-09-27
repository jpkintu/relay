import { useState } from 'react';
import { BellRing, Share, X } from 'lucide-react';
import { useNotifications } from '../lib/notifications';
import { sendTestPush, waitForArrival, type Arrival, type TestResult } from '../lib/push';

const ARRIVAL: Record<Arrival, { good: boolean; text: string }> = {
  shown: {
    good: true,
    text: 'received and handed to the system. If no banner appeared, notifications for this browser are off or silenced on the device: on Windows, Settings → System → Notifications (Chrome on, Do not disturb / Focus off); on Android, Settings → Apps → Chrome (or Relay) → Notifications, and Do not disturb off.',
  },
  error: { good: false, text: 'received, but the browser would not show it: ' },
  'not-received': {
    good: false,
    text: 'Google / Apple accepted it, but it has not reached this device yet. Check the device is online, the network does not block push notifications, and battery saver lets the browser run in the background.',
  },
};

// Notifications are on: a test button that says, per device, whether the
// push service accepted it (the notification itself shows even with Relay open).
function PushOn() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');
  const [arrival, setArrival] = useState<{ arrival: Arrival; message: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const test = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    setArrival(null);
    try {
      const sent = await sendTestPush();
      setResult(sent);
      if (sent.sent > 0) {
        setWaiting(true);
        setArrival(await waitForArrival(sent.testId));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the test');
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  };
  return (
    <div className="push-state on">
      <p>
        <BellRing aria-hidden /> Notifications are on for this device
      </p>
      <button className="link-button" disabled={busy} onClick={() => void test()}>
        {waiting ? 'Waiting for it to arrive…' : busy ? 'Sending…' : 'Send a test notification'}
      </button>
      {error && <p className="ops-error">{error}</p>}
      {result && (
        <ul className="push-test">
          {!result.devices.length && (
            <li className="bad">No device is registered for you. Turn notifications on again.</li>
          )}
          {result.devices.map((d, i) => (
            <li key={i} className={d.ok ? 'good' : 'bad'}>
              <b>{d.device}</b>: {d.ok ? 'sent. It should appear in a few seconds.' : d.problem}
            </li>
          ))}
          {arrival && (
            <li className={ARRIVAL[arrival.arrival].good ? 'good' : 'bad'}>
              <b>This device</b>: {ARRIVAL[arrival.arrival].text}
              {arrival.message}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

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

  if (push === 'on') return <PushOn />;
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
