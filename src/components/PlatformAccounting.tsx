import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Download, Printer } from 'lucide-react';
import Parse from '../parse';
import { formatDate, formatMoney } from '../lib/format';
import { printReceiptBatch } from '../lib/subscriptionReceipt';

// Relay Hosted, platform console → Accounting: money received against
// revenue earned each month (subscriptions paid in advance are earned over
// their period; the rest is a prepayment), the month's invoices to export,
// and Zoho Books (cloud/platformAccounting.js).

type Row = {
  id: string;
  number: string;
  amount: number;
  currency: string;
  paidAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  months: number;
  kind: 'period' | 'upgrade';
  planName: string;
  method: 'iotec' | 'manual';
  payer: string;
  reference: string;
  discount: number;
  discountCode: string;
  restaurant: string;
  code: string;
  ownerName: string;
  ownerEmail: string;
  billingPhone: string;
  earnedBefore: number;
  earnedInMonth: number;
  deferredAfter: number;
  paidInMonth: boolean;
  zohoInvoiceId: string;
  zohoPaymentId: string;
  zohoError: string;
};
type ZohoView = {
  connected: boolean;
  ready: boolean;
  dc: string;
  orgId: string;
  orgName: string;
  clientId: string;
  secretSet: boolean;
  accounts: { deferred?: string; revenue?: string; deposit?: string };
  accountNames: { deferred?: string; revenue?: string; deposit?: string };
  autoSync: boolean;
  fromMonth: string;
  dataCentres: Record<string, string>;
  chart?: { id: string; name: string; type: string }[];
  error?: string;
};
type Accounting = {
  month: string;
  currency: string;
  closed: boolean;
  totals: {
    received: number;
    earned: number;
    earnedFromThisMonth: number;
    earnedFromEarlier: number;
    deferredFromThisMonth: number;
    prepaidAtEnd: number;
  };
  rows: Row[];
  billingFrom: string;
  supportContact: string;
  posting: { amount: number; zohoJournalId: string; postedAt: string | null; by: string } | null;
  zoho: ZohoView;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const thisMonth = () => new Date().toISOString().slice(0, 7);
const csvCell = (value: unknown) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function PlatformAccounting({ timeZone }: { timeZone: string }) {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<Accounting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await Parse.Cloud.run('platformGetAccounting', { month }));
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, [month]);
  useEffect(() => {
    void load();
  }, [load]);

  const money = (n: number) => formatMoney(n, data?.currency || 'UGX');
  const day = (value: string | null) => formatDate(value, timeZone, { dateStyle: 'medium' });

  const act = async (name: string, ok: (result: Record<string, unknown>) => string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      setDone(ok(await Parse.Cloud.run(name, { month })));
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = () => {
    if (!data) return;
    const head = [
      'Invoice',
      'Restaurant',
      'Code',
      'Paid on',
      'Period start',
      'Period end',
      'Months',
      'Kind',
      'Plan',
      'Amount',
      'Discount',
      'Earned before the month',
      'Earned in the month',
      'Prepaid at month end',
      'Paid in the month',
      'Method',
      'Reference',
      'Zoho invoice',
      'Zoho payment',
    ];
    const lines = data.rows.map((r) =>
      [
        r.number,
        r.restaurant,
        r.code,
        r.paidAt.slice(0, 10),
        r.periodStart?.slice(0, 10) || '',
        r.periodEnd?.slice(0, 10) || '',
        r.months,
        r.kind,
        r.planName,
        r.amount,
        r.discount,
        r.earnedBefore,
        r.earnedInMonth,
        r.deferredAfter,
        r.paidInMonth ? 'yes' : 'no',
        r.method === 'manual' ? 'Recorded by RelayEats' : 'Mobile money',
        r.reference,
        r.zohoInvoiceId,
        r.zohoPaymentId,
      ]
        .map(csvCell)
        .join(','),
    );
    const t = data.totals;
    const summary = [
      '',
      `Received in ${data.month},${t.received}`,
      `Earned in ${data.month},${t.earned}`,
      `  from this month's payments,${t.earnedFromThisMonth}`,
      `  from earlier prepayments,${t.earnedFromEarlier}`,
      `Prepaid from this month's payments,${t.deferredFromThisMonth}`,
      `Prepayment balance at month end,${t.prepaidAtEnd}`,
    ];
    const blob = new Blob([[head.join(','), ...lines, ...summary].join('\n')], {
      type: 'text/csv',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `relay-earnings-${data.month}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const printInvoices = () => {
    if (!data) return;
    const paid = data.rows.filter((r) => r.paidInMonth);
    printReceiptBatch(
      paid.map((r) => ({
        payment: {
          id: r.id,
          amount: r.amount,
          currency: r.currency,
          months: r.months,
          method: r.method,
          payer: r.payer,
          reference: r.reference,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          paidAt: r.paidAt,
          discount: r.discount,
          discountCode: r.discountCode,
          kind: r.kind,
          planName: r.planName,
        },
        restaurant: {
          name: r.restaurant,
          code: r.code,
          ownerName: r.ownerName,
          ownerEmail: r.ownerEmail,
          billingPhone: r.billingPhone,
          planName: r.planName,
          billingFrom: data.billingFrom,
          supportContact: data.supportContact,
        },
      })),
      timeZone,
      `RelayEats invoices ${data.month}`,
    );
  };

  const t = data?.totals;
  const paidRows = data?.rows.filter((r) => r.paidInMonth) || [];
  const zoho = data?.zoho;
  const inZoho = paidRows.filter((r) => r.zohoPaymentId).length;

  return (
    <>
      <section className="admin-panel accounting">
        <div className="panel-title">
          <div>
            <h2>Accounting</h2>
            <p className="muted">
              Subscriptions are paid in advance and earned day by day over the period they pay for.
              What is paid for later months is a prepayment (unearned revenue) until then.
            </p>
          </div>
          <label className="setup-field accounting-month">
            Month
            <input
              type="month"
              value={month}
              max={thisMonth()}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        {done && <p className="form-success">{done}</p>}
        {!data || !t ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="admin-metrics">
              <article>
                <span>Received in the month</span>
                <strong>{money(t.received)}</strong>
                <small>
                  {paidRows.length} payment{paidRows.length === 1 ? '' : 's'}
                </small>
              </article>
              <article>
                <span>Earned in the month</span>
                <strong>{money(t.earned)}</strong>
                <small>
                  {money(t.earnedFromThisMonth)} from this month&apos;s payments ·{' '}
                  {money(t.earnedFromEarlier)} from earlier prepayments
                </small>
              </article>
              <article>
                <span>Prepaid from this month&apos;s payments</span>
                <strong>{money(t.deferredFromThisMonth)}</strong>
                <small>Paid now for later months</small>
              </article>
              <article>
                <span>Prepayment balance at month end</span>
                <strong>{money(t.prepaidAtEnd)}</strong>
                <small>Unearned revenue still to earn</small>
              </article>
            </div>
            <div className="platform-actions">
              <button className="secondary-button" onClick={downloadCsv}>
                <Download size={16} /> Download CSV
              </button>
              <button
                className="secondary-button"
                disabled={!paidRows.length}
                onClick={printInvoices}
              >
                <Printer size={16} /> Print the month&apos;s invoices
              </button>
              {zoho?.ready && (
                <>
                  <button
                    className="secondary-button"
                    disabled={busy || !paidRows.length}
                    onClick={() =>
                      void act(
                        'platformSyncZoho',
                        (r) =>
                          `${String(r.synced)} sent to Zoho Books${
                            Array.isArray(r.errors) && r.errors.length
                              ? `; ${r.errors.length} failed: ${(r.errors as string[]).join('; ')}`
                              : ''
                          }.`,
                      )
                    }
                  >
                    Send invoices to Zoho Books
                  </button>
                  {data.closed && !data.posting && (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          'platformPostEarnings',
                          (r) =>
                            `Posted ${money(Number(r.amount) || 0)} earned in ${data.month} to Zoho Books.`,
                        )
                      }
                    >
                      Post {data.month} earnings to Zoho
                    </button>
                  )}
                </>
              )}
            </div>
            <p className="muted small">
              {zoho?.ready
                ? `${inZoho} of ${paidRows.length} payments of the month are in Zoho Books. `
                : 'Connect Zoho Books below to send invoices and earnings automatically. '}
              {data.posting
                ? `Earnings journal posted ${day(data.posting.postedAt)} (${money(data.posting.amount)}${
                    data.posting.by ? `, ${data.posting.by}` : ''
                  }).`
                : data.closed
                  ? 'Earnings for this month are not posted yet.'
                  : 'The earnings journal is posted once the month is over.'}
            </p>
            {data.rows.length > 0 ? (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Paid</th>
                      <th>Period</th>
                      <th className="num">Amount</th>
                      <th className="num">Earned before</th>
                      <th className="num">Earned this month</th>
                      <th className="num">Prepaid after</th>
                      <th>Zoho</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <b>{r.number}</b>
                          <small className="cell-sub">
                            {r.restaurant}
                            {r.planName ? ` · ${r.planName}` : ''}
                          </small>
                        </td>
                        <td>
                          {day(r.paidAt)}
                          {!r.paidInMonth && <small className="cell-sub">earlier</small>}
                        </td>
                        <td>
                          {r.periodStart ? `${day(r.periodStart)} – ${day(r.periodEnd)}` : '—'}
                          <small className="cell-sub">
                            {r.kind === 'upgrade'
                              ? 'upgrade'
                              : r.months === 12
                                ? '1 year'
                                : `${r.months} month${r.months === 1 ? '' : 's'}`}
                          </small>
                        </td>
                        <td className="num">{money(r.amount)}</td>
                        <td className="num">{money(r.earnedBefore)}</td>
                        <td className="num">
                          <b>{money(r.earnedInMonth)}</b>
                        </td>
                        <td className="num">{money(r.deferredAfter)}</td>
                        <td>
                          {r.zohoPaymentId ? (
                            <span className="status-pill good">In Zoho</span>
                          ) : r.zohoError ? (
                            <span className="status-pill bad" title={r.zohoError}>
                              Failed
                            </span>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No subscription money in this month.</p>
            )}
          </>
        )}
      </section>
      <ZohoSettings onChanged={() => void load()} />
    </>
  );
}

// Connecting Zoho Books, and the three accounts.
function ZohoSettings({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = useState<ZohoView | null>(null);
  const [form, setForm] = useState({
    dc: 'com',
    orgId: '',
    clientId: '',
    clientSecret: '',
    grantCode: '',
  });
  const [accounts, setAccounts] = useState({ deferred: '', revenue: '', deposit: '' });
  const [autoSync, setAutoSync] = useState(false);
  const [fromMonth, setFromMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      const next: ZohoView = await Parse.Cloud.run('platformGetZoho');
      setView(next);
      setForm((f) => ({ ...f, dc: next.dc, orgId: next.orgId, clientId: next.clientId }));
      setAccounts({
        deferred: next.accounts.deferred || '',
        revenue: next.accounts.revenue || '',
        deposit: next.accounts.deposit || '',
      });
      setAutoSync(next.autoSync);
      setFromMonth(next.fromMonth);
      if (next.error) setError(next.error);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (name: string, params: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await Parse.Cloud.run(name, params);
      setDone(ok);
      setForm((f) => ({ ...f, clientSecret: '', grantCode: '' }));
      await load();
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run('platformConnectZoho', form, 'Connected to Zoho Books.');
  };
  const chart = view?.chart || [];
  const pick = (types: string[]) => chart.filter((a) => types.includes(a.type));
  const name = (id: string) => chart.find((a) => a.id === id)?.name || '';
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  if (!view) return null;
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>Zoho Books</h2>
          <p className="muted">
            Each payment becomes a Zoho invoice (booked to prepayments) with its payment, and each
            month&apos;s earnings move from prepayments to revenue in one journal.
          </p>
        </div>
        <span className={`status-pill ${view.ready ? 'good' : ''}`}>
          {view.ready
            ? `Connected${view.orgName ? `: ${view.orgName}` : ''}`
            : view.connected
              ? 'Choose the accounts'
              : 'Not connected'}
        </span>
      </div>
      {error && <p className="form-error">{error}</p>}
      {done && <p className="form-success">{done}</p>}
      {!view.connected ? (
        <form className="platform-form" onSubmit={connect}>
          <ol className="platform-note zoho-steps">
            <li>
              Open{' '}
              <a href="https://api-console.zoho.com/" target="_blank" rel="noreferrer">
                api-console.zoho.com
              </a>{' '}
              (signed in to the Zoho account of your books) → Add client → <b>Self Client</b>.
            </li>
            <li>Copy its client ID and client secret here.</li>
            <li>
              Under <b>Generate code</b>, scope <code>ZohoBooks.fullaccess.all</code>, time 10
              minutes; paste the code here and press Connect within those minutes.
            </li>
            <li>
              The organization ID is in Zoho Books → Settings → Organization profile. Your books
              should use the same currency as RelayEats.
            </li>
          </ol>
          <label className="setup-field">
            Zoho data centre
            <select value={form.dc} onChange={set('dc')}>
              {Object.entries(view.dataCentres).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            Organization ID
            <input inputMode="numeric" value={form.orgId} onChange={set('orgId')} />
          </label>
          <label className="setup-field">
            Client ID
            <input value={form.clientId} onChange={set('clientId')} autoComplete="off" />
          </label>
          <label className="setup-field">
            Client secret
            <input
              type="password"
              value={form.clientSecret}
              onChange={set('clientSecret')}
              autoComplete="off"
              placeholder={view.secretSet ? 'Saved (leave empty to keep it)' : ''}
            />
          </label>
          <label className="setup-field platform-note">
            Grant code
            <input value={form.grantCode} onChange={set('grantCode')} autoComplete="off" />
          </label>
          <div className="platform-actions platform-note">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      ) : (
        <div className="platform-form">
          {(
            [
              [
                'deferred',
                'Prepayments (unearned revenue)',
                ['other_current_liability', 'other_liability', 'current_liability'],
              ],
              ['revenue', 'Subscription revenue', ['income', 'other_income']],
              [
                'deposit',
                'Where the money lands (bank, mobile money wallet)',
                ['bank', 'cash', 'other_current_asset'],
              ],
            ] as const
          ).map(([key, label, types]) => (
            <label key={key} className="setup-field">
              {label}
              <select
                value={accounts[key]}
                onChange={(e) => setAccounts((a) => ({ ...a, [key]: e.target.value }))}
              >
                <option value="">Choose an account</option>
                {(pick([...types]).length ? pick([...types]) : chart).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="setup-field">
            Start with the month
            <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} />
            <small>Earlier payments stay out (enter opening balances in Zoho).</small>
          </label>
          <label className="setup-checkbox platform-note">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
            />{' '}
            Automatically: send each payment when it is received, and post each month&apos;s
            earnings once it is over
          </label>
          <div className="platform-actions platform-note">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(
                  'platformSaveZoho',
                  {
                    accounts,
                    accountNames: {
                      deferred: name(accounts.deferred),
                      revenue: name(accounts.revenue),
                      deposit: name(accounts.deposit),
                    },
                    autoSync,
                    fromMonth,
                  },
                  'Saved.',
                )
              }
            >
              Save
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                window.confirm('Disconnect Zoho Books? Nothing already sent is removed.') &&
                void run('platformDisconnectZoho', {}, 'Disconnected.')
              }
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
