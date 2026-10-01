import { useState } from 'react';
import { Download } from 'lucide-react';
import { useSession } from '../lib/session';
import { formatDate, formatMoney } from '../lib/format';
import { printSubscriptionInvoice } from '../lib/subscriptionReceipt';
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
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Pay</h2>
            <p className="muted">
              Pay a month, a few months or a whole year with MTN MoMo or Airtel Money. Each payment
              extends your paid period from where it ends now.
            </p>
          </div>
        </div>
        <BillingPanel onLoaded={setBilling} />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Plans</h2>
            <p className="muted">
              Compare the plans monthly or yearly. Moving to a smaller plan needs your restaurant
              within its limits; the new price applies from your next payment.
            </p>
          </div>
        </div>
        <PlanPicker />
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Account</h2>
            <p className="muted">
              Relay sends password reset links, receipts and reminders to this email.
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
                        {inv.months === 12
                          ? '1 year'
                          : `${inv.months} month${inv.months === 1 ? '' : 's'}`}
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
                        onClick={() =>
                          printSubscriptionInvoice(inv, r, config.timezone, r.supportContact)
                        }
                      >
                        <Download size={15} /> PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
