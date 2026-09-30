import { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useInstall } from '../lib/install';
import { restaurantTitle, useConfig } from '../lib/session';

const DISMISS_KEY = 'relay:install-dismissed';
const DISMISS_DAYS = 14;

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Date.now() - at < DISMISS_DAYS * 864e5;
  } catch {
    return false;
  }
}

// Offers to put the app on the home screen: it then opens full screen like an
// app, starts faster and keeps working through a weak signal. `button` is the
// plain version for profile pages (always shown while installing is possible).
export function InstallPrompt({ button = false }: { button?: boolean }) {
  const { state, install } = useInstall();
  const name = restaurantTitle(useConfig().restaurantName);
  const [hidden, setHidden] = useState(dismissedRecently);
  const [iosHelp, setIosHelp] = useState(false);
  if (state === 'installed' || state === 'unavailable') return null;

  if (button)
    return (
      <div className="install-inline">
        {state === 'available' ? (
          <button type="button" className="setup-secondary" onClick={() => void install()}>
            <Download /> Install {name} on this device
          </button>
        ) : iosHelp ? (
          <p className="muted small">
            Tap <Share aria-label="Share" className="inline-icon" /> Share, then{' '}
            <b>Add to Home Screen</b>.
          </p>
        ) : (
          <button type="button" className="setup-secondary" onClick={() => setIosHelp(true)}>
            <Download /> Add {name} to the Home Screen
          </button>
        )}
      </div>
    );

  // On iPhone/iPad the notifications card already explains Add to Home Screen.
  if (hidden || state === 'ios') return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Private mode: it just shows again next time.
    }
    setHidden(true);
  };
  return (
    <div className="push-prompt card install-prompt">
      <Download aria-hidden className="push-prompt-icon" />
      <div>
        <strong>Install {name} on this device</strong>
        {state === 'available' ? (
          <span>
            Opens full screen from your home screen, starts faster and copes with a weak signal.
          </span>
        ) : (
          <span>
            Tap <Share aria-label="Share" className="inline-icon" /> Share →{' '}
            <b>Add to Home Screen</b>. {name} then opens full screen like an app.
          </span>
        )}
      </div>
      {state === 'available' && (
        <button onClick={() => void install().then((ok) => ok || dismiss())}>Install</button>
      )}
      <button className="push-dismiss" aria-label="Not now" onClick={dismiss}>
        <X />
      </button>
    </div>
  );
}

// A strip across the top while the device has no connection.
export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You are offline. The app catches up as soon as the connection is back.
    </div>
  );
}
