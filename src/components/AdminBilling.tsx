import { useRef, useState } from 'react';
import { Copy, Download, Share2 } from 'lucide-react';
import { useSession } from '../lib/session';
import { formatDate, formatMoney } from '../lib/format';
import { printSubscriptionInvoice, printSubscriptionReceipt } from '../lib/subscriptionReceipt';
import { BillingPanel, OwnerEmail, PlanPicker, daysLeft, type Billing } from './Subscription';

// Relay Hosted, Admin → Billing: the restaurant's subscription, paying for
// it (a month, a few months or a year), the plans, the account email and the
// invoices to download.

const STATUS: Record<string, string> = {
  trial: 'Free trial',
  active: 'Paid',
  past_due: 'Payment overdue',
  expired: 'Closed',
  suspended: 'Suspended',
};

export function AdminBilling() {
  const { profile, config } = useSession();
  const r = profile?.restaurant;
  const [billing, setBilling] = useState<Billing | null>(null);
  const [upgradeTo, setUpgradeTo] = useState<string | null>(null);
  const [payOn, setPayOn] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const payRef = useRef<HTMLElement>(null);
  const toPay = () => payRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!r) return null;
  const money = (n: number) => formatMoney(n, r.currency);
  const day = (value: string | null) => formatDate(value, config.timezone, { dateStyle: 'medium' });
  const invoices = billing?.invoices || [];
  const left = daysLeft(r.until);
  return (
    <div className="data-page billing-page">
      <section className="admin-panel billing-summary">
        <div>
          <p className="muted small">Your plan</p>
          <h2>
            {r.planName || 'Plan'}{' '}
            <span
              className={`status-pill ${r.status === 'active' ? 'good' : r.status === 'trial' ? '' : 'bad'}`}
            >
              {STATUS[r.status] || r.status}
            </span>
          </h2>
        </div>
        <dl>
          <div>
            <dt>{r.status === 'trial' ? 'Trial ends' : 'Paid until'}</dt>
            <dd>
              {day(r.until)}
              <small>{left > 0 ? `${left} day${left === 1 ? '' : 's'} left` : 'Today'}</small>
            </dd>
          </div>
          <div>
            <dt>Monthly</dt>
            <dd>{money(r.monthlyPrice)}</dd>
          </div>
          {typeof r.annualPrice === 'number' && (
            <div>
              <dt>A year at once</dt>
              <dd>
                {money(r.annualPrice)}
                {r.monthlyPrice * 12 > r.annualPrice && (
                  <small>save {money(r.monthlyPrice * 12 - r.annualPrice)}</small>
                )}
              </dd>
            </div>
          )}
        </dl>
        {billing?.plan && billing.plan.renewal !== billing.plan.current && (
          <p className="billing-next-plan">
            Moving to <b>{billing.plan.renewalName}</b> on {day(billing.plan.renewalFrom)}; until
            then you keep {billing.plan.currentName}.
          </p>
        )}
      </section>

      <section className="admin-panel" ref={payRef}>
        <div className="panel-title">
          <div>
            <h2>{upgradeTo ? 'Upgrade' : 'Pay'}</h2>
            <p className="muted">
              Pay a month, a few months or a whole year with MTN MoMo or Airtel Money. Each payment
              extends your paid period from where it ends now.
            </p>
          </div>
        </div>
        <BillingPanel
          onLoaded={setBilling}
          upgradeTo={upgradeTo}
          onUpgradeClose={() => setUpgradeTo(null)}
          choosePlan={payOn}
          reloadKey={reloadKey}
        />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Plans</h2>
            <p className="muted">
              Compare the plans monthly or yearly. Moving up while a paid period runs costs only the
              difference for the days left; moving down starts when the paid period ends.
            </p>
          </div>
        </div>
        <PlanPicker
          billing={billing}
          onUpgrade={(plan) => {
            setUpgradeTo(plan);
            toPay();
          }}
          onPayOn={(plan) => {
            setUpgradeTo(null);
            setPayOn(plan);
            toPay();
          }}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Account</h2>
            <p className="muted">
              RelayEats sends password reset links, receipts and reminders to this email.
            </p>
          </div>
        </div>
        <OwnerEmail />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Invoices</h2>
            <p className="muted">
              Paid invoices, and the next one once your period is about to end. Download any of them
              as a PDF (choose “Save as PDF” in the print window).
            </p>
          </div>
        </div>
        {!billing ? (
          <p className="muted">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.number}>
                    <td data-label="Invoice">
                      <b>{inv.number}</b>
                      <small className="cell-sub">
                        {inv.status === 'paid'
                          ? `Paid ${day(inv.issuedAt)}`
                          : `Due ${day(inv.dueAt)}`}
                      </small>
                    </td>
                    <td data-label="Period">
                      {day(inv.periodStart)} – {day(inv.periodEnd)}
                      <small className="cell-sub">
                        {inv.kind === 'upgrade'
                          ? `Upgrade to ${inv.planName || 'a bigger plan'}`
                          : `${inv.planName ? `${inv.planName}, ` : ''}${
                              inv.months === 12
                                ? '1 year'
                                : `${inv.months} month${inv.months === 1 ? '' : 's'}`
                            }`}
                      </small>
                    </td>
                    <td data-label="Status">
                      <span
                        className={`status-pill ${inv.status === 'paid' ? 'good' : inv.status === 'overdue' ? 'bad' : ''}`}
                      >
                        {inv.status === 'paid'
                          ? 'Paid'
                          : inv.status === 'overdue'
                            ? 'Overdue'
                            : 'Unpaid'}
                      </span>
                    </td>
                    <td data-label="Amount" className="num">
                      {formatMoney(inv.amount, inv.currency)}
                    </td>
                    <td className="actions-cell">
                      <button
                        className="setup-secondary"
                        onClick={() => printSubscriptionInvoice(inv, r, config.timezone)}
                      >
                        <Download size={15} /> Invoice
                      </button>
                      {inv.status === 'paid' && inv.paymentId && (
                        <button
                          className="setup-secondary"
                          onClick={() =>
                            printSubscriptionReceipt(
                              {
                                id: inv.paymentId as string,
                                amount: inv.amount,
                                currency: inv.currency,
                                months: inv.months,
                                method: inv.method || 'iotec',
                                payer: inv.payer || '',
                                reference: inv.reference || '',
                                periodStart: inv.periodStart,
                                periodEnd: inv.periodEnd,
                                paidAt: inv.issuedAt,
                                discount: inv.discount || 0,
                                kind: inv.kind,
                                planName: inv.planName,
                                discountCode: inv.discountCode || '',
                              },
                              r,
                              config.timezone,
                            )
                          }
                        >
                          <Download size={15} /> Receipt
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {billing?.referrals && <ReferSection referrals={billing.referrals} />}
    </div>
  );
}

// Refer a restaurant: this restaurant's code as a sign-up link, the terms,
// and the restaurants that used it.
function ReferSection({ referrals }: { referrals: NonNullable<Billing['referrals']> }) {
  const { config } = useSession();
  const [done, setDone] = useState('');
  const link = `${window.location.origin}/?ref=${encodeURIComponent(referrals.code)}`;
  const on = referrals.percent > 0;
  const reward = `${referrals.months} free month${referrals.months === 1 ? '' : 's'}`;
  const text = `Run your restaurant on RelayEats. Sign up with my code ${referrals.code} and pay now to get ${referrals.percent}% off your first payment: ${link}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setDone('Link copied.');
    } catch {
      setDone(link);
    }
  };
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'RelayEats', text, url: link });
        return;
      } catch {
        // Cancelled: nothing to do.
      }
    } else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };
  const day = (value: string | null) => formatDate(value, config.timezone, { dateStyle: 'medium' });
  const STATUS_TEXT = {
    rewarded: (months: number) => `Paid · you got ${months} free month${months === 1 ? '' : 's'}`,
    waiting: () => 'Signed up · not paid yet',
    trial: () => 'Chose the free trial · no reward',
  };
  return (
    <section className="admin-panel refer">
      <div className="panel-title">
        <div>
          <h2>Refer a restaurant</h2>
          <p className="muted">
            {on
              ? `Share your code. They save ${referrals.percent}% on their first payment, and you get ${reward} once they have paid.`
              : 'Referrals are switched off at the moment.'}
          </p>
        </div>
      </div>
      {on && (
        <>
          <div className="refer-code">
            <span>Your code</span>
            <strong>{referrals.code}</strong>
            <div className="refer-actions">
              <button className="primary-button" onClick={() => void share()}>
                <Share2 size={16} /> Refer
              </button>
              <button className="secondary-button" onClick={() => void copy()}>
                <Copy size={16} /> Copy link
              </button>
            </div>
            {done && <small className="muted">{done}</small>}
          </div>
          <details className="refer-terms" open>
            <summary>How referrals work</summary>
            <ul>
              <li>
                The new restaurant signs up with your code (or your link) and chooses <b>Pay now</b>
                . Codes do not apply to a free trial.
              </li>
              <li>
                They get {referrals.percent}% off their first payment, whatever period they pay for.
              </li>
              <li>
                Once that payment has gone through, {reward} {referrals.months === 1 ? 'is' : 'are'}{' '}
                added to your paid period, once per restaurant. You get a notification and an email.
              </li>
              <li>
                If they switch to the free trial before paying, the code no longer applies and there
                is no reward.
              </li>
              <li>RelayEats can change these terms; rewards already given stay.</li>
            </ul>
          </details>
        </>
      )}
      <h3>Your referrals</h3>
      {referrals.rows.length === 0 ? (
        <p className="muted">No restaurant has signed up with your code yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data compact-table">
            <thead>
              <tr>
                <th>Restaurant</th>
                <th>Signed up</th>
                <th>Status</th>
                <th>Rewarded</th>
              </tr>
            </thead>
            <tbody>
              {referrals.rows.map((row) => (
                <tr key={`${row.name}-${row.signedUpAt}`}>
                  <td>{row.name}</td>
                  <td>{day(row.signedUpAt)}</td>
                  <td>
                    <span className={`status-pill ${row.status === 'rewarded' ? 'good' : ''}`}>
                      {STATUS_TEXT[row.status](row.months)}
                    </span>
                  </td>
                  <td>{row.rewardedAt ? day(row.rewardedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
