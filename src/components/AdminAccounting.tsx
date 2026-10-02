import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Printer } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { rangeLabel, todayIn } from '../lib/range';
import {
  BranchSelect,
  FilterBar,
  filterParams,
  Stat,
  useBranchOptions,
  useCloud,
  useFilters,
} from './reports/common';
import { EXPENSE_CATEGORY_NAMES, PURCHASE_CATEGORY_NAMES } from './AdminSpending';
import { AdminVouchers } from './AdminVouchers';

// Owner and finance: profit and loss, balance sheet and cash flow
// (cloud/accounting.js, rules in cloud/lib/accounts.js), and the EFRIS
// fiscal receipts to follow up.

type PL = {
  revenue: { food: number; delivery: number; total: number; orders: number };
  costOfSales: { byCategory: { key: string; amount: number }[]; total: number };
  grossProfit: number;
  operating: {
    riderCommission: number;
    riderDeliveryFees: number;
    expenses: { key: string; amount: number }[];
    fromTills: number;
    total: number;
  };
  netProfit: number;
  grossMargin: number | null;
  netMargin: number | null;
};

const TABS = [
  ['pl', 'Profit & loss'],
  ['balance', 'Balance sheet'],
  ['cash', 'Cash flow'],
  ['vouchers', 'Refunds & vouchers'],
  ['tax', 'Tax receipts'],
] as const;
type Tab = (typeof TABS)[number][0];

export function AdminAccounting() {
  const [tab, setTab] = useState<Tab>('pl');
  return (
    <div className="report accounting">
      <div className="filter-toggle spending-tabs no-print" role="tablist" aria-label="Accounting">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'pl' && <ProfitAndLoss />}
      {tab === 'balance' && <BalanceSheet />}
      {tab === 'cash' && <CashFlow />}
      {tab === 'vouchers' && <AdminVouchers />}
      {tab === 'tax' && <TaxReceipts />}
    </div>
  );
}

function PrintButton() {
  return (
    <button className="filter-action no-print" onClick={() => window.print()}>
      <Printer size={16} /> Print
    </button>
  );
}

// One line of a statement: label, amount, and optionally the previous period.
function Row({
  label,
  value,
  before,
  strong,
  indent,
  negative,
}: {
  label: ReactNode;
  value: number;
  before?: number;
  strong?: boolean;
  indent?: boolean;
  negative?: boolean;
}) {
  const money = useMoney();
  const show = (n: number) => (negative && n ? `(${money(n)})` : money(n));
  return (
    <div className={`statement-row${strong ? ' strong' : ''}${indent ? ' indent' : ''}`}>
      <span>{label}</span>
      {before !== undefined && <span className="num muted">{show(before)}</span>}
      <span className="num">{show(value)}</span>
    </div>
  );
}

function StatementHead({ title, subtitle }: { title: string; subtitle: string }) {
  const { restaurantName } = useConfig();
  return (
    <header className="statement-head">
      <p className="eyebrow">{restaurantName}</p>
      <h2>{title}</h2>
      <p className="muted small">{subtitle}</p>
    </header>
  );
}

function ProfitAndLoss() {
  const [filters, setFilters] = useFilters('thisMonth');
  const branches = useBranchOptions();
  const { data, error, loading } = useCloud<{
    range: { from: string; to: string };
    previousRange: { from: string; to: string };
    current: PL;
    previous: PL;
  }>('getProfitAndLoss', filterParams(filters));
  const c = data?.current;
  const p = data?.previous;
  const branch = branches.find((b) => b.id === filters.branchId)?.name;
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <PrintButton />
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {c && p && data && (
        <article className="admin-panel statement">
          <StatementHead
            title={`Profit and loss${branch ? ` · ${branch}` : ''}`}
            subtitle={`${rangeLabel(data.range)} (previous: ${rangeLabel(data.previousRange)})`}
          />
          <div className="statement-row head">
            <span />
            <span className="num">Previous</span>
            <span className="num">This period</span>
          </div>
          <h3>Revenue</h3>
          <Row label="Food and drinks" value={c.revenue.food} before={p.revenue.food} indent />
          <Row
            label="Delivery fees"
            value={c.revenue.delivery}
            before={p.revenue.delivery}
            indent
          />
          <Row label="Total revenue" value={c.revenue.total} before={p.revenue.total} strong />
          <h3>Cost of sales (stock bought)</h3>
          {c.costOfSales.byCategory.map((row) => (
            <Row
              key={row.key}
              label={PURCHASE_CATEGORY_NAMES[row.key] || row.key}
              value={row.amount}
              before={p.costOfSales.byCategory.find((x) => x.key === row.key)?.amount ?? 0}
              indent
              negative
            />
          ))}
          <Row
            label="Total cost of sales"
            value={c.costOfSales.total}
            before={p.costOfSales.total}
            strong
            negative
          />
          <Row
            label={
              <>
                Gross profit
                {c.grossMargin !== null && <small> · {c.grossMargin}% of revenue</small>}
              </>
            }
            value={c.grossProfit}
            before={p.grossProfit}
            strong
          />
          <h3>Operating costs</h3>
          <Row
            label="Rider commission"
            value={c.operating.riderCommission}
            before={p.operating.riderCommission}
            indent
            negative
          />
          <Row
            label="Delivery fees paid to riders"
            value={c.operating.riderDeliveryFees}
            before={p.operating.riderDeliveryFees}
            indent
            negative
          />
          {c.operating.expenses.map((row) => (
            <Row
              key={row.key}
              label={EXPENSE_CATEGORY_NAMES[row.key] || row.key}
              value={row.amount}
              before={p.operating.expenses.find((x) => x.key === row.key)?.amount ?? 0}
              indent
              negative
            />
          ))}
          {(c.operating.fromTills > 0 || p.operating.fromTills > 0) && (
            <Row
              label="Paid from the tills"
              value={c.operating.fromTills}
              before={p.operating.fromTills}
              indent
              negative
            />
          )}
          <Row
            label="Total operating costs"
            value={c.operating.total}
            before={p.operating.total}
            strong
            negative
          />
          <Row
            label={
              <>
                {c.netProfit < 0 ? 'Net loss' : 'Net profit'}
                {c.netMargin !== null && <small> · {c.netMargin}% of revenue</small>}
              </>
            }
            value={c.netProfit}
            before={p.netProfit}
            strong
          />
          <p className="muted small statement-note">
            Revenue counts orders delivered or served in the period; stock is a cost when bought;
            rider pay is a cost when the order is delivered. Record purchases and expenses under
            Purchases &amp; expenses.
          </p>
        </article>
      )}
    </div>
  );
}

function BalanceSheet() {
  const money = useMoney();
  const { timezone } = useConfig();
  const today = todayIn(timezone);
  const [day, setDay] = useState(today);
  const branches = useBranchOptions();
  const [branchId, setBranchId] = useState('');
  const { data, error, loading, reload } = useCloud<{
    day: string;
    openingBalance: number;
    openingSet: boolean;
    sheet: {
      assets: { cash: number; receivable: number; total: number };
      liabilities: { suppliers: number; riders: number; refunds?: number; total: number };
      equity: { opening: number; profit: number; other: number; total: number };
    };
    refunds?: { owed: RefundRow[]; cleared: RefundRow[] };
  }>('getBalanceSheet', { day, ...(branchId && { branchId }) });
  const navigate = useNavigate();
  const [opening, setOpening] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const s = data?.sheet;
  const branch = branches.find((b) => b.id === branchId)?.name;
  return (
    <div className={loading ? 'busy' : ''}>
      <div className="filter-bar no-print">
        <label>
          <span>As at</span>
          <input
            type="date"
            value={day}
            max={today}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        </label>
        <BranchSelect
          value={branchId}
          onChange={setBranchId}
          branches={branches}
          allLabel="Whole restaurant"
        />
        <PrintButton />
      </div>
      {error && <p className="ops-error">{error}</p>}
      {data && !data.openingSet && !branchId && (
        <form
          className="setup-notice opening-form no-print"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setSaveError('');
            try {
              await Parse.Cloud.run('saveOpeningBalance', { amount: Number(opening) });
              reload();
            } catch (err) {
              setSaveError(err instanceof Error ? err.message : 'Could not save');
            } finally {
              setSaving(false);
            }
          }}
        >
          <span>
            Enter the cash and bank the restaurant had when it started using RelayEats, so the cash
            figure is right.
          </span>
          <input
            type="number"
            min="0"
            inputMode="numeric"
            aria-label="Opening cash and bank"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
          <button disabled={saving || opening === ''}>Save</button>
          {saveError && <span className="form-error">{saveError}</span>}
        </form>
      )}
      {s && data && (
        <article className="admin-panel statement">
          <StatementHead
            title={`Balance sheet${branch ? ` · ${branch}` : ''}`}
            subtitle={`As at the end of ${formatDate(`${data.day}T12:00:00Z`, 'UTC', {
              dateStyle: 'long',
            })}`}
          />
          <h3>What the restaurant has</h3>
          <Row label="Cash and bank" value={s.assets.cash} indent />
          <Row
            label="Still to receive for sales (cash with riders, payments being checked, open bills)"
            value={s.assets.receivable}
            indent
          />
          <Row label="Total assets" value={s.assets.total} strong />
          <h3>What it owes</h3>
          <Row label="To suppliers (unpaid purchases)" value={s.liabilities.suppliers} indent />
          <Row label="To riders (unpaid pay)" value={s.liabilities.riders} indent />
          {(s.liabilities.refunds || 0) > 0 && (
            <Row
              label="Refunds owed to customers (paid for cancelled orders)"
              value={s.liabilities.refunds || 0}
              indent
            />
          )}
          <Row label="Total liabilities" value={s.liabilities.total} strong />
          <h3>Owner&apos;s equity</h3>
          <Row label="Opening balance" value={s.equity.opening} indent />
          <Row label="Profit to date" value={s.equity.profit} indent />
          {s.equity.other !== 0 && (
            <Row
              label="Other differences (cash shortages, till differences)"
              value={s.equity.other}
              indent
            />
          )}
          <Row label="Total equity" value={s.equity.total} strong />
          <p className="muted small statement-note">
            Assets less liabilities: {money(s.assets.total - s.liabilities.total)}, the same as the
            total equity. Cash and bank is worked out from the opening balance, money received for
            sales, and what was paid out; check it against your bank and till counts.
            {branchId && ' A branch’s balance sheet has no opening balance.'}
          </p>
        </article>
      )}
      {data?.refunds && (data.refunds.owed.length > 0 || data.refunds.cleared.length > 0) && (
        <article className="admin-panel statement">
          <h3>Refunds to customers</h3>
          <p className="muted small">
            Money paid for orders that were then cancelled, kept as the customer&apos;s vouchers.
            Owed until refunded (less the charges for sending it) or spent on an order that was
            delivered; then cleared. Manage them under Refunds &amp; vouchers.
          </p>
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Voucher</th>
                  <th>Paid</th>
                  <th className="num">Owed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...data.refunds.owed, ...data.refunds.cleared].map((r) => (
                  <tr
                    key={r.id}
                    className={r.orderId ? 'clickable' : ''}
                    tabIndex={r.orderId ? 0 : undefined}
                    onClick={() => r.orderId && navigate(`/admin/orders/${r.orderId}`)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && r.orderId && navigate(`/admin/orders/${r.orderId}`)
                    }
                  >
                    <td data-label="Voucher">
                      <span className="code">{r.code}</span>
                      {r.orderCode && <small className="block muted">{r.orderCode}</small>}
                    </td>
                    <td data-label="Paid">{formatDate(r.receivedAt, timezone)}</td>
                    <td data-label="Owed" className="num">
                      {money(r.owed)}
                    </td>
                    <td data-label="Status">
                      {r.refundedAt ? (
                        <>
                          <span className="status-pill good">Cleared: refunded</span>{' '}
                          <small className="muted">
                            {money(r.sent)} sent, {money(r.charges)} charges ·{' '}
                            {formatDate(r.refundedAt, timezone)}
                            {r.note ? ` · ${r.note}` : ''}
                          </small>
                        </>
                      ) : r.owed === 0 ? (
                        <>
                          <span className="status-pill good">Cleared: spent</span>{' '}
                          <small className="muted">on {r.usedCode}</small>
                        </>
                      ) : r.usedAt ? (
                        <>
                          <span className="status-pill bad">Owed</span>{' '}
                          <small className="muted">spent on {r.usedCode}, not yet served</small>
                        </>
                      ) : (
                        <span className="status-pill bad">Owed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </div>
  );
}

type RefundRow = {
  id: string;
  code: string;
  amount: number;
  owed: number;
  orderId: string;
  orderCode: string;
  usedCode: string;
  receivedAt: string;
  usedAt: string | null;
  refundedAt: string | null;
  sent: number;
  charges: number;
  note: string;
};

const FLOW_NAMES: Record<string, string> = {
  sales: 'Received for sales',
  refund_receipts: 'Received for cancelled orders (owed back)',
  refunds: 'Refunds sent to customers',
  refund_charges: 'Charges for sending refunds',
  suppliers: 'Paid to suppliers',
  expenses: 'Expenses paid',
  rider_pay: 'Rider pay paid out',
  till_expenses: 'Paid from the tills',
};

function CashFlow() {
  const [filters, setFilters] = useFilters('thisMonth');
  const branches = useBranchOptions();
  const { data, error, loading } = useCloud<{
    range: { from: string; to: string };
    opening: number;
    inflows: { key: string; amount: number }[];
    outflows: { key: string; amount: number }[];
    net: number;
    closing: number;
  }>('getCashFlow', filterParams(filters));
  const branch = branches.find((b) => b.id === filters.branchId)?.name;
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <PrintButton />
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && (
        <article className="admin-panel statement">
          <StatementHead
            title={`Cash flow${branch ? ` · ${branch}` : ''}`}
            subtitle={rangeLabel(data.range)}
          />
          <Row label="Cash and bank at the start" value={data.opening} strong />
          <h3>Money in</h3>
          {data.inflows.map((row) => (
            <Row key={row.key} label={FLOW_NAMES[row.key] || row.key} value={row.amount} indent />
          ))}
          <h3>Money out</h3>
          {data.outflows.map((row) => (
            <Row
              key={row.key}
              label={FLOW_NAMES[row.key] || row.key}
              value={row.amount}
              indent
              negative
            />
          ))}
          <Row
            label={data.net < 0 ? 'Net cash out' : 'Net cash in'}
            value={Math.abs(data.net)}
            strong
            negative={data.net < 0}
          />
          <Row label="Cash and bank at the end" value={data.closing} strong />
          <p className="muted small statement-note">
            Sales money counts once it is in hand: cash counted in, mobile money and card verified.
          </p>
        </article>
      )}
    </div>
  );
}

type TaxRow = {
  id: string;
  code: string;
  at: string;
  total: number;
  customer: string;
  status: 'issued' | 'failed' | 'pending';
  fdn: string;
  error: string;
  attempts: number;
};
const TAX_STATUS: Record<string, [string, string]> = {
  issued: ['Issued', 'good'],
  failed: ['Refused / not sent', 'bad'],
  pending: ['Waiting', 'warn'],
};

function TaxReceipts() {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const [filters, setFilters] = useFilters('last7');
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useCloud<{
    enabled: boolean;
    counts: { issued: number; failed: number; pending: number };
    rows: TaxRow[];
  }>('listEfrisReceipts', filterParams(filters, status ? { status } : {}));
  const [busy, setBusy] = useState('');
  const [sendError, setSendError] = useState('');
  const send = async (id: string) => {
    setBusy(id);
    setSendError('');
    try {
      await Parse.Cloud.run('issueEfrisReceipt', { orderId: id });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy('');
      reload();
    }
  };
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <label>
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="failed">Refused / not sent</option>
            <option value="pending">Waiting</option>
            <option value="issued">Issued</option>
          </select>
        </label>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && !data.enabled && (
        <p className="setup-notice">
          EFRIS receipts are off. The owner connects the EFRIS account in Admin → Tax (EFRIS).
        </p>
      )}
      {sendError && <p className="ops-error">{sendError}</p>}
      {data && (
        <>
          <div className="stat-grid">
            <Stat label="Issued" value={data.counts.issued} />
            <Stat label="Refused or not sent" value={data.counts.failed} />
            <Stat label="Waiting" value={data.counts.pending} />
          </div>
          <section className="admin-panel admin-section-panel">
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="num">Total</th>
                    <th>Receipt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Order">
                        <button
                          className="link-button"
                          onClick={() => navigate(`/admin/orders/${row.id}`)}
                        >
                          {row.code}
                        </button>
                        <small>
                          {formatDate(row.at, timezone, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                          {row.customer && ` · ${row.customer}`}
                        </small>
                      </td>
                      <td data-label="Total" className="num">
                        {money(row.total)}
                      </td>
                      <td data-label="Receipt">
                        <span className={`status-pill ${TAX_STATUS[row.status]?.[1] || ''}`}>
                          {TAX_STATUS[row.status]?.[0] || row.status}
                        </span>
                        {row.fdn && <small>FDN {row.fdn}</small>}
                        {row.error && <small className="bad-text">{row.error}</small>}
                      </td>
                      <td className="actions-cell">
                        {row.status !== 'issued' && data.enabled && (
                          <button
                            className="setup-secondary"
                            disabled={busy === row.id}
                            onClick={() => void send(row.id)}
                          >
                            {busy === row.id ? 'Sending…' : 'Send now'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!data.rows.length && (
                    <tr>
                      <td colSpan={4} className="empty-orders">
                        No sales to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
