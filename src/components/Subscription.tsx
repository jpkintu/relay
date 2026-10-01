import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, LogOut, Minus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  // A year paid at once (default: 10 months).
  annualPrice: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
};

const LIMIT_WORDS: Record<string, [string, string]> = {
  branches: ['branch', 'branches'],
  cashier: ['cashier', 'cashiers'],
  rider: ['rider', 'riders'],
  finance: ['finance member', 'finance members'],
};
const LIMIT_LABELS: Record<string, string> = {
  branches: 'Branches',
  cashier: 'Cashiers',
  rider: 'Riders',
  finance: 'Finance staff',
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
      return n === null || n === undefined ? `Unlimited ${many}` : `${n} ${n === 1 ? one : many}`;
    });
  const parts = Object.entries(FEATURE_WORDS)
    .filter(([key]) => plan.features[key])
    .map(([, words]) => words);
  return [...limits, ...parts];
}

// A plan card's table: each limit ("Unlimited" when there is none) and each
// part of the app, included or not.
export function planSpec(plan: OfferedPlan) {
  return {
    limits: Object.keys(LIMIT_LABELS).map((key) => {
      const n = plan.limits[key];
      return {
        key,
        label: LIMIT_LABELS[key],
        value: n === null || n === undefined ? 'Unlimited' : n === 0 ? 'None' : String(n),
      };
    }),
    features: Object.entries(FEATURE_WORDS)
      .filter(([key]) => key !== 'finance')
      .map(([key, label]) => ({ key, label, included: !!plan.features[key] })),
  };
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

// One plan: price, what it allows and what it includes. With `onSelect`
// (the sign-up form) the card itself is a choice.
export type Cycle = 'month' | 'year';

// Monthly or annual prices on the plan cards.
export function CycleToggle({ cycle, onChange }: { cycle: Cycle; onChange: (c: Cycle) => void }) {
  return (
    <div className="filter-toggle cycle-toggle" role="tablist" aria-label="Billing period">
      {(
        [
          ['month', 'Monthly'],
          ['year', 'Annual · 2 months free'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={cycle === key}
          className={cycle === key ? 'active' : ''}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function PlanCard({
  plan,
  currency,
  current,
  action,
  onSelect,
  badge = 'Your plan',
  cycle = 'month',
}: {
  plan: OfferedPlan;
  currency: string;
  current: boolean;
  action?: ReactNode;
  onSelect?: () => void;
  badge?: string;
  cycle?: Cycle;
}) {
  // A year at once; 10 months when the server did not say (older servers).
  const annual = typeof plan.annualPrice === 'number' ? plan.annualPrice : plan.price * 10;
  const saving = plan.price * 12 - annual;
  const spec = planSpec(plan);
  const choice = onSelect
    ? {
        role: 'radio',
        'aria-checked': current,
        tabIndex: 0,
        onClick: onSelect,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        },
      }
    : { 'aria-current': current || undefined };
  return (
    <article
      className={`plan-card${current ? ' current' : ''}${onSelect ? ' choosable' : ''}`}
      {...choice}
    >
      <header className="plan-card-head">
        <h3>{plan.name}</h3>
        {current && <span className="status-pill good">{badge}</span>}
      </header>
      {cycle === 'year' ? (
        <p className="plan-price">
          <strong>{formatMoney(annual, currency)}</strong>
          <span>a year</span>
          {saving > 0 && <em className="plan-saving">Save {formatMoney(saving, currency)}</em>}
        </p>
      ) : (
        <p className="plan-price">
          <strong>{formatMoney(plan.price, currency)}</strong>
          <span>a month</span>
        </p>
      )}
      {cycle === 'month' && annual > 0 && (
        <p className="plan-annual">or {formatMoney(annual, currency)} paid yearly</p>
      )}
      {plan.description && <p className="plan-description">{plan.description}</p>}
      <dl className="plan-limits">
        {spec.limits.map((limit) => (
          <div key={limit.key} className={limit.value === 'Unlimited' ? 'unlimited' : ''}>
            <dt>{limit.label}</dt>
            <dd>{limit.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="plan-includes">
        {spec.features.map((feature) => (
          <li key={feature.key} className={feature.included ? '' : 'excluded'}>
            {feature.included ? (
              <Check aria-label="Included" size={16} />
            ) : (
              <Minus aria-label="Not included" size={16} />
            )}
            {feature.label}
          </li>
        ))}
      </ul>
      {!current && action && <div className="plan-action">{action}</div>}
    </article>
  );
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
  const [cycle, setCycle] = useState<Cycle>('month');
  if (!r || !offered) return null;
  return (
    <div className="plan-picker">
      <CycleToggle cycle={cycle} onChange={setCycle} />
      {offered.plans.map((plan) => (
        <PlanCard
          key={plan.key}
          plan={plan}
          currency={offered.currency}
          cycle={cycle}
          current={plan.key === r.plan}
          action={
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
          }
        />
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
// The owner, on the Overview: only when something needs doing (the trial,
// the last days of a paid period, or a period that has ended). Everything
// else about the subscription is in Admin → Billing.
const NOTICE_DAYS = 7;
export function SubscriptionNotice() {
  const { profile, config } = useSession();
  const navigate = useNavigate();
  const [paying, setPaying] = useState(false);
  const r = profile?.restaurant;
  if (!r || profile?.role !== 'admin') return null;
  const left = daysLeft(r.until);
  const needed = r.status === 'trial' || r.status === 'past_due' || left <= NOTICE_DAYS;
  const noEmail = !r.ownerEmail;
  if (!needed && !noEmail) return null;
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
            <b>Free trial:</b> {plural(left, 'day')} left (until {date}). Then {priceText(r)}.
          </>
        ) : needed ? (
          <>
            <b>Subscription:</b> paid until {date} ({plural(left, 'day')} left) · {priceText(r)}.
          </>
        ) : (
          <>
            <b>Add your email</b> so you can reset your password and get Relay&apos;s reminders.
          </>
        )}
      </span>
      {!paying && (
        <span className="subscription-actions">
          <button className="setup-secondary" onClick={() => navigate('/admin/site/billing')}>
            Billing
          </button>
          {needed && (
            <button onClick={() => setPaying(true)}>
              {r.status === 'active' ? 'Pay ahead' : 'Pay now'}
            </button>
          )}
        </span>
      )}
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
  if (r.payFirst) return <PayFirstScreen />;
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

// Signed up to pay now (no free trial): the owner pays the first period, with
// the sign-up code taken off, or starts the free trial instead.
function PayFirstScreen() {
  const { profile, logout, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const r = profile?.restaurant;
  if (!r) return null;
  const owner = profile?.role === 'admin';
  const trialInstead = async () => {
    if (
      r.offerCode &&
      !window.confirm(`Start the free trial instead? The code ${r.offerCode} will no longer apply.`)
    )
      return;
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('startTrialInstead');
      await refresh();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <main className="auth-shell">
      <AuthSide />
      <section className="auth-panel">
        <div className="login-card">
          <BrandMark className="mobile-brand" />
          <p className="eyebrow">{r.name}</p>
          <h2>Pay to start.</h2>
          {owner ? (
            <>
              <p className="muted">
                You chose to pay now instead of a free trial. Pay your first period to open the app
                for you and your team.
              </p>
              <BillingPanel />
              {error && <p className="form-error">{error}</p>}
              {(r.trialDays ?? 0) > 0 && (
                <button
                  className="link-button pay-first-trial"
                  disabled={busy}
                  onClick={() => void trialInstead()}
                >
                  Start the {r.trialDays}-day free trial instead
                </button>
              )}
            </>
          ) : (
            <p className="muted">
              {r.name} opens once the owner has made the first payment. You can sign in as soon as
              they do.
            </p>
          )}
          <div className="closed-actions">
            <button className="secondary-button" onClick={() => void refresh()}>
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
export type Invoice = {
  number: string;
  status: 'paid' | 'due' | 'overdue';
  issuedAt: string;
  dueAt: string | null;
  months: number;
  amount: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  paymentId: string | null;
  // A first payment with a sign-up code: the price before it.
  listAmount?: number | null;
  discount?: number;
  discountCode?: string;
  // Paid invoices: how it was paid (for the receipt).
  method?: 'iotec' | 'manual';
  payer?: string;
  reference?: string;
};
export type Billing = {
  restaurant: RestaurantSummary;
  prices: Record<number, number>;
  // Before a sign-up code (offers.js), and the code's wording.
  listPrices?: Record<number, number>;
  offer?: { code: string; type: 'code' | 'referral'; label: string; referrerName: string } | null;
  invoices: Invoice[];
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
export function BillingPanel({
  onClose,
  initialMonths = 1,
  onLoaded,
}: {
  onClose?: () => void;
  initialMonths?: number;
  onLoaded?: (billing: Billing) => void;
}) {
  const { refresh, config } = useSession();
  const [data, setData] = useState<Billing | null>(null);
  const [months, setMonths] = useState(initialMonths);
  useEffect(() => setMonths(initialMonths), [initialMonths]);
  const [phone, setPhone] = useState('');
  const [current, setCurrent] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next: Billing = await Parse.Cloud.run('getBilling');
      setData(next);
      onLoaded?.(next);
      setPhone((p) => p || next.billingPhone);
      const waiting = next.payments.find((pay) => pay.status === 'pending');
      if (waiting) setCurrent(waiting);
    } catch (e) {
      setError(message(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // What the server will charge (12 months: the annual price).
  const priceOf = (m: number) => data.prices?.[m] ?? r.monthlyPrice * m;
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
      {data.offer && (
        <p className="billing-offer" role="status">
          <b>{data.offer.code}</b>
          {data.offer.type === 'referral' && data.offer.referrerName
            ? ` (referred by ${data.offer.referrerName}): `
            : ': '}
          {data.offer.label}.
        </p>
      )}
      {!data.payInApp ? (
        <p className="muted">
          Paying in the app is not switched on yet. Contact Relay{contact} to pay.
        </p>
      ) : (
        current?.status !== 'pending' && (
          <form className="billing-form" onSubmit={(e) => void pay(e)}>
            <label className="setup-field">
              Pay for
              <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {m === 12 ? '1 year' : `${m} month${m === 1 ? '' : 's'}`} · {money(priceOf(m))}
                    {r.monthlyPrice * m > priceOf(m)
                      ? ` (save ${money(r.monthlyPrice * m - priceOf(m))})`
                      : ''}
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
                {busy ? 'Sending…' : `Pay ${money(priceOf(months))}`}
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

// The owner's email (password reset links and Relay's emails): shown under
// the subscription notice, with a way to change it.
export function OwnerEmail() {
  const { profile, refresh } = useSession();
  const current = profile?.restaurant?.ownerEmail || '';
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('updateOwnerEmail', { email });
      await refresh();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the email');
    } finally {
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <p className={`owner-email${current ? '' : ' missing'}`}>
        {current ? (
          <>
            Account email: <b>{current}</b>
          </>
        ) : (
          <>
            <b>Add your email</b> so you can reset your password and get Relay&apos;s reminders.
          </>
        )}{' '}
        <button
          className="link-button"
          onClick={() => {
            setEmail(current);
            setEditing(true);
          }}
        >
          {current ? 'Change' : 'Add email'}
        </button>
      </p>
    );
  return (
    <form className="owner-email" onSubmit={save}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        aria-label="Account email"
        required
      />
      <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="setup-secondary" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}
