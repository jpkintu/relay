import { LogOut } from 'lucide-react';
import { formatDate, formatMoney } from '../lib/format';
import { useSession, type RestaurantSummary } from '../lib/session';
import { BrandMark } from './BrandMark';

// Relay Hosted: the restaurant's subscription as the app shows it.

const DAY = 86400000;
export const daysLeft = (until: string | null) =>
  until ? Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / DAY)) : 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const priceText = (r: RestaurantSummary) => `${formatMoney(r.monthlyPrice, r.currency)} a month`;

// Everyone, during the grace days after the trial or paid month ends.
export function SubscriptionBanner() {
  const { profile } = useSession();
  const r = profile?.restaurant;
  if (!r || r.status !== 'past_due') return null;
  const days = plural(daysLeft(r.until), 'day');
  return (
    <p className="subscription-banner" role="status">
      {profile?.role === 'admin'
        ? `Your Relay subscription has ended. Renew within ${days} to keep the app open.`
        : `The restaurant’s Relay subscription has ended. The owner has ${days} to renew it.`}
    </p>
  );
}

// The owner, on the Overview: trial or paid-until, and the monthly price.
export function SubscriptionNotice() {
  const { profile, config } = useSession();
  const r = profile?.restaurant;
  if (!r || profile?.role !== 'admin' || r.status === 'past_due') return null;
  const date = formatDate(r.until, config.timezone, { dateStyle: 'medium' });
  return (
    <div className="setup-notice subscription-notice">
      <span>
        {r.status === 'trial' ? (
          <>
            <b>Free trial:</b> {plural(daysLeft(r.until), 'day')} left (until {date}). Then{' '}
            {priceText(r)}.
          </>
        ) : (
          <>
            <b>Relay subscription:</b> paid until {date} · {priceText(r)}.
          </>
        )}
      </span>
    </div>
  );
}

// Expired or suspended: nothing works until the owner renews (or Relay lifts
// the suspension). The owner sees what to pay; staff see who to ask.
export function ClosedScreen() {
  const { profile, config, logout, refresh } = useSession();
  const r = profile?.restaurant;
  if (!r) return null;
  const owner = profile?.role === 'admin';
  const contact = r.supportContact ? ` (${r.supportContact})` : '';
  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="login-card">
          <BrandMark className="mobile-brand" />
          <p className="eyebrow">{r.name}</p>
          <h2>{r.status === 'suspended' ? 'Paused.' : 'Subscription ended.'}</h2>
          {r.status === 'suspended' ? (
            <p className="muted">
              Relay has paused this restaurant. Nothing has been deleted. Contact Relay
              {contact} to reopen it.
            </p>
          ) : owner ? (
            <>
              <p className="muted">
                {r.until
                  ? `Your ${r.paidUntil ? 'paid month' : 'free trial'} ended on ${formatDate(
                      r.until,
                      config.timezone,
                      { dateStyle: 'medium' },
                    )}. `
                  : ''}
                Renew to open the app again for you and your team. Nothing has been deleted.
              </p>
              <dl className="subscription-facts">
                <dt>Price</dt>
                <dd>{priceText(r)}</dd>
              </dl>
              <p className="muted">
                To renew, contact Relay{contact}. Paying from the app is coming soon.
              </p>
            </>
          ) : (
            <p className="muted">
              {r.name}’s Relay subscription has ended. Ask the owner to renew it; you can sign in
              again as soon as they do.
            </p>
          )}
          <div className="closed-actions">
            <button className="primary-button" onClick={() => void refresh()}>
              Check again
            </button>
            <button className="preview-button" onClick={() => void logout()}>
              <LogOut size={17} /> Sign out
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
