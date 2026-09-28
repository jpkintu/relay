// Crash reporting: errors in the app are sent to the server
// (reportClientError) and listed for the owner under Admin → Errors.
// Nothing is sent about what the person typed; only the error, where in the
// app it happened, the page address and the browser.
import Parse from '../parse';
import { savedRestaurant } from './restaurant';

const MAX_PER_VISIT = 10;
const sent = new Set<string>();

// Noise that is not a bug in Relay: browser extensions, the browser's own
// resize warnings, and cross-origin errors that carry no detail.
const IGNORED = [/ResizeObserver loop/, /^Script error\.?$/, /extension:\/\//];

// The area of the app, e.g. "/admin/orders" without record ids.
const area = () => window.location.pathname.replace(/\/[A-Za-z0-9]{10,}(?=\/|$)/g, '/:id');

export function reportError(error: unknown, where = '') {
  const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const message = `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}`.slice(
    0,
    500,
  );
  const stack = err.stack || '';
  if (!err.message || IGNORED.some((pattern) => pattern.test(message) || pattern.test(stack)))
    return;
  const key = `${where}|${message}`;
  if (sent.has(key) || sent.size >= MAX_PER_VISIT) return;
  sent.add(key);
  const place = where || area();
  Parse.Cloud.run('reportClientError', {
    message,
    stack: stack.slice(0, 4000),
    where: place,
    url: `${window.location.origin}${area()}`,
    userAgent: navigator.userAgent,
    appVersion: import.meta.env.VITE_APP_VERSION || '',
    // Relay Hosted: which restaurant a signed-out report belongs to.
    restaurant: savedRestaurant(),
  }).catch(() => undefined);
}

// Catches what no screen handled: script errors and failed promises.
export function listenForErrors() {
  window.addEventListener('error', (event) => {
    if (event.filename && !event.filename.startsWith(window.location.origin)) return;
    reportError(event.error || new Error(event.message), area());
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    // A Cloud function refusing something (wrong PIN, no permission) is not
    // a crash; those reach the person on screen.
    if (reason && typeof reason === 'object' && typeof (reason as Parse.Error).code === 'number')
      return;
    reportError(reason, area());
  });
}
