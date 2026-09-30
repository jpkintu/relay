import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { LogOut } from 'lucide-react';
import Parse from '../parse';
import { formatDate, formatMoney } from '../lib/format';
import { printSubscriptionReceipt } from '../lib/subscriptionReceipt';
import { useSession, type RestaurantSummary } from '../lib/session';
import { AuthSide } from './AuthSide';
import { BrandMark } from './BrandMark';

// Relay Hosted: the restaurant's subscription as the app shows it.

const DAY = 86400000;
export const daysLeft = (until: string | null) =>
  until ? Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / DAY)) : 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const priceText = (r: RestaurantSummary) =>
  `${r.planName || 'Your'} plan · ${formatMoney(r.monthlyPrice, r.currency)} a month`;

// The plans on offer (set by Relay in the platform console).
export type OfferedPlan = {
  key: string;
  name: string;
  description: string;
  price: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
};

const LIMIT_WORDS: Record<string, [string, string]> = {
  branches: ['branch', 'branches'],
  cashier: ['cashier', 'cashiers'],
  rider: ['rider', 'riders'],
  finance: ['finance member', 'finance members'],
};
const FEATURE_WORDS: Record<string, string> = {
  finance: 'Finance role',
  accounting: 'Purchases, expenses & accounting',
  reports: 'Reports & analytics',
  efris: 'EFRIS tax receipts',
  whatsapp: 'WhatsApp daily summaries',
};

// One line per limit and included part, for plan cards and the sign-up list.
export function planPoints(plan: OfferedPlan): string[] {
  const limits = Object.entries(LIMIT_WORDS)
    .filter(([key]) => !(key === 'finance' && plan.limits.finance === 0))
    .map(([key, [one, many]]) => {
      const n = plan.limits[key];
      return n === null || n === undefined
        ? `Any number of ${many}`
        : `${n} ${n === 1 ? one : many}`;
    });
  const parts = Object.entries(FEATURE_WORDS)
    .filter(([key]) => plan.features[key])
    .map(([, words]) => words);
  return [...limits, ...parts];
}

export function useOfferedPlans() {
  const [data, setData] = useState<{ currency: string; plans: OfferedPlan[] } | null>(null);
  useEffect(() => {
    Parse.Cloud.run('getPlans')
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return data;
}

// The owner: the plans on offer and a switch between them. Moving to a
// smaller plan needs the restaurant within its limits (the server says what
// is over).
export function PlanPicker() {
  const { profile, refresh } = useSession();
  const r = profile?.restaurant;
  const offered = useOfferedPlans();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!r || !offered) return null;
  return (
    <div className="plan-picker">
      {offered.plans.map((plan) => (
        <article key={plan.key} className={plan.key === r.plan ? 'plan-card current' : 'plan-card'}>
          <h3>{plan.name}</h3>
          <strong>
            {formatMoney(plan.price, offered.currency)}
            <small> a month</small>
          </strong>
          {plan.description && <p className="muted small">{plan.description}</p>}
          <ul>
            {planPoints(plan).map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {plan.key === r.plan ? (
            <span className="status-pill good">Your plan</span>
          ) : (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await Parse.Cloud.run('changePlan', { plan: plan.key });
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not change the plan');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Switch to {plan.name}
            </button>
          )}
        </article>
      ))}
      {error && <p className="form-error">{error}</p>}
      <p className="muted small">
        A negotiated price stays as agreed. The new plan&apos;s price applies from your next
        payment.
      </p>
    </div>
  );
}

// Everyone, during the grace days after the trial or paid month ends.
export function SubscriptionBanner() {
  const { profile } = useSession();
  const r = profile?.restaurant;
  if (!r || r.status !== 'past_due') return null;
  const days = plural(daysLeft(r.until), 'day');
  return (
    <p className="subscription-banner" role="status">
      {profile?.role === 'admin'
        ? `Your subscription has ended. Renew within ${days} to keep the app open.`
        : `The restaurant’s subscription has ended. The owner has ${days} to renew it.`}
    </p>
  );
}

// The owner, on the Overview: trial or paid-until, and the monthly price.
export function SubscriptionNotice() {
  const { profile, config } = useSession();
  const [paying, setPaying] = useState(false);
  const [plans, setPlans] = useState(false);
  const r = profile?.restaurant;
  if (!r || profile?.role !== 'admin') return null;
  const date = formatDate(r.until, config.timezone, { dateStyle: 'medium' });
  return (
    <div className={`setup-notice subscription-notice${paying ? ' open' : ''}`}>
      <span>
        {r.status === 'past_due' ? (
          <>
            <b>Subscription ended.</b> Pay by {date} to keep the app open · {priceText(r)}.
          </>
        ) : r.status === 'trial' ? (
          <>
            <b>Free trial:</b> {plural(daysLeft(r.until), 'day')} left (until {date}). Then{' '}
            {priceText(r)}.
          </>
        ) : (
          <>
            <b>Subscription:</b> paid until {date} · {priceText(r)}.
          </>
        )}
      </span>
      {!paying && (
        <span className="subscription-actions">
          <button className="setup-secondary" onClick={() => setPlans((v) => !v)}>
            {plans ? 'Hide plans' : 'Plans'}
          </button>
          <button onClick={() => setPaying(true)}>
            {r.status === 'active' ? 'Pay ahead' : 'Pay now'}
          </button>
        </span>
      )}
      {plans && !paying && <PlanPicker />}
      {paying && <BillingPanel onClose={() => setPaying(false)} />}
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
      <AuthSide />
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
              <BillingPanel />
            </>
          ) : (
            <p className="muted">
              {r.name}’s subscription has ended. Ask the owner to renew it; you can sign in again as
              soon as they do.
            </p>
          )}
          <div className="closed-actions">
            <button
              className={owner && r.status !== 'suspended' ? 'secondary-button' : 'primary-button'}
              onClick={() => void refresh()}
            >
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

type Payment = {
  id: string;
  createdAt: string | null;
  amount: number;
  currency: string;
  months: number;
  method: 'iotec' | 'manual';
  status: 'pending' | 'paid' | 'failed';
  payer: string;
  message: string;
  reference: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
};
type Billing = {
  restaurant: RestaurantSummary;
  payInApp: boolean;
  sandbox: boolean;
  billingPhone: string;
  months: number[];
  payments: Payment[];
};

const POLL_MS = 4000;
const message = (e: unknown) => (e instanceof Error ? e.message : 'That did not work');

// The owner pays the Relay subscription with mobile money (ioTec): choose the
// months, approve the prompt on the phone, and the app opens again.
export function BillingPanel({ onClose }: { onClose?: () => void }) {
  const { refresh, config } = useSession();
  const [data, setData] = useState<Billing | null>(null);
  const [months, setMonths] = useState(1);
  const [phone, setPhone] = useState('');
  const [current, setCurrent] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next: Billing = await Parse.Cloud.run('getBilling');
      setData(next);
      setPhone((p) => p || next.billingPhone);
      const waiting = next.payments.find((pay) => pay.status === 'pending');
      if (waiting) setCurrent(waiting);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  // Follows a waiting payment until the phone answers.
  useEffect(() => {
    if (current?.status !== 'pending') return;
    timer.current = window.setTimeout(async () => {
      try {
        const { payment } = await Parse.Cloud.run('checkSubscriptionPayment', { id: current.id });
        setCurrent(payment);
        if (payment.status !== 'pending') {
          await load();
          if (payment.status === 'paid') await refresh();
        }
      } catch (e) {
        setError(message(e));
      }
    }, POLL_MS);
    return () => window.clearTimeout(timer.current);
  }, [current, load, refresh]);

  const pay = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setCurrent(await Parse.Cloud.run('startSubscriptionPayment', { months, phone }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const r = data.restaurant;
  const money = (n: number) => formatMoney(n, r.currency);
  const day = (value: string | null) => formatDate(value, config.timezone, { dateStyle: 'medium' });
  const contact = r.supportContact ? ` (${r.supportContact})` : '';
  return (
    <div className="billing-panel">
      {current?.status === 'pending' ? (
        <div className="billing-waiting" role="status">
          <b>Check your phone ({current.payer}).</b> Approve {money(current.amount)} for Relay with
          your mobile money PIN. This page updates by itself.
        </div>
      ) : current?.status === 'paid' ? (
        <p className="form-success">
          Paid, thank you. Relay is open until {day(current.periodEnd)}.
        </p>
      ) : current?.status === 'failed' ? (
        <p className="form-error">
          Not paid: {current.message || 'the payment did not go through'}.
        </p>
      ) : null}
      {!data.payInApp ? (
        <p className="muted">
          Paying in the app is not switched on yet. Contact Relay{contact} to renew.
        </p>
      ) : (
        current?.status !== 'pending' && (
          <form className="billing-form" onSubmit={(e) => void pay(e)}>
            <label className="setup-field">
              Pay for
              <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {m} month{m === 1 ? '' : 's'} · {money(r.monthlyPrice * m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="setup-field">
              Mobile money number
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder="07…"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="billing-actions">
              <button className="primary-button" disabled={busy}>
                {busy ? 'Sending…' : `Pay ${money(r.monthlyPrice * months)}`}
              </button>
              {onClose && (
                <button type="button" className="secondary-button" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
            {data.sandbox && (
              <small className="muted">
                Test mode: no real money moves. Use an ioTec test number such as 256111777777; real
                numbers are refused.
              </small>
            )}
          </form>
        )
      )}
      {data.payments.length > 0 && (
        <details className="billing-history">
          <summary>Past payments</summary>
          <ul>
            {data.payments.map((p) => (
              <li key={p.id}>
                <span>{day(p.createdAt)}</span>
                <span>
                  {money(p.amount)} · {p.months} month{p.months === 1 ? '' : 's'}
                  {p.method === 'manual' ? ' · recorded by Relay' : ''}
                </span>
                <span className={`billing-status ${p.status}`}>
                  {p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Not paid' : 'Waiting'}
                  {p.reference ? ` · ${p.reference}` : ''}
                  {p.status === 'paid' && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => printSubscriptionReceipt(p, r, config.timezone)}
                    >
                      Receipt
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
