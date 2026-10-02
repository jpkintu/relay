import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useNavigate } from 'react-router-dom';
import { Printer } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { bucketLabel, rangeLabel, todayIn } from '../lib/range';
import { useDevice } from '../lib/device';
import { Chart, SERIES } from './reports/Chart';
import {
  BranchSelect,
  FilterBar,
  filterParams,
  useBranchOptions,
  useCloud,
  useFilters,
} from './reports/common';
import { EXPENSE_CATEGORY_NAMES, PURCHASE_CATEGORY_NAMES } from './AdminSpending';

// The standard financial statements (cloud/accounting.js, rules in
// cloud/lib/accounts.js): Profit and Loss, Balance Sheet and Cash Flow
// Statement, each with a column to compare, and Business Performance Ratios.

type PL = {
  revenue: { food: number; delivery: number; total: number; orders: number };
  costOfSales: {
    byCategory: { key: string; amount: number }[];
    purchases: number;
    openingStock: number;
    closingStock: number;
    total: number;
  };
  grossProfit: number;
  operating: {
    riderCommission: number;
    riderDeliveryFees: number;
    expenses: { key: string; amount: number }[];
    fromTills: number;
    total: number;
  };
  netProfit: number;
};

type Position = {
  assets: {
    tills: number;
    bank: number;
    cash: number;
    receivable: number;
    inventory: number;
    current: number;
    equipment: number;
    fixed: number;
    total: number;
  };
  liabilities: {
    suppliers: number;
    riders: number;
    refunds: number;
    current: number;
    total: number;
  };
  equity: {
    opening: number;
    retained: number;
    currentYear: number;
    other: number;
    total: number;
  };
};

type Flow = {
  beginning: number;
  operating: { netIncome: number; lines: { key: string; amount: number }[]; total: number };
  investing: { lines: { key: string; amount: number }[]; total: number };
  financing: { lines: { key: string; amount: number }[]; total: number };
  netChange: number;
  ending: number;
};

// A line of a statement: a heading, an account (indented by depth), a
// subtotal or a grand total, with one amount per column.
type Line = {
  label: ReactNode;
  values?: number[];
  kind?: 'section' | 'item' | 'total' | 'grand';
  depth?: number;
};

export function PrintButton() {
  return (
    <button className="filter-action no-print" onClick={() => window.print()}>
      <Printer size={16} /> Print
    </button>
  );
}

function Statement({
  title,
  subtitle,
  columns,
  lines,
  note,
}: {
  title: string;
  subtitle: ReactNode;
  columns: string[];
  lines: Line[];
  note?: ReactNode;
}) {
  const money = useMoney();
  const { restaurantName } = useConfig();
  return (
    <article className="admin-panel statement fin-statement">
      <header className="statement-head">
        <p className="eyebrow">{restaurantName}</p>
        <h2>{title}</h2>
        <p className="muted small">{subtitle}</p>
      </header>
      <div className="fin-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              {columns.map((c) => (
                <th key={c} className="num">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={`fin-${line.kind || 'item'}`}>
                <td style={{ paddingLeft: `${0.6 + (line.depth || 0) * 1.1}rem` }}>{line.label}</td>
                {line.values
                  ? line.values.map((v, j) => (
                      <td key={j} className="num">
                        {money(v)}
                      </td>
                    ))
                  : columns.map((c) => <td key={c} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="muted small statement-note">{note}</p>}
    </article>
  );
}

// Rows for accounts listed by key in either column (categories).
function byKeyRows(
  columns: { key: string; amount: number }[][],
  names: Record<string, string>,
  depth: number,
): Line[] {
  const keys = [...new Set(columns.flatMap((rows) => rows.map((r) => r.key)))];
  return keys.map((key) => ({
    label: names[key] || key,
    values: columns.map((rows) => rows.find((r) => r.key === key)?.amount ?? 0),
    depth,
  }));
}

export function ProfitAndLoss() {
  const [filters, setFilters] = useFilters('thisMonth');
  const branches = useBranchOptions();
  const { data, error, loading } = useCloud<{
    range: { from: string; to: string };
    previousRange: { from: string; to: string };
    current: PL;
    previous: PL;
  }>('getProfitAndLoss', filterParams(filters));
  const branch = branches.find((b) => b.id === filters.branchId)?.name;
  const cols = data ? [data.previous, data.current] : [];
  const v = (pick: (pl: PL) => number) => cols.map(pick);
  const lines: Line[] = data
    ? [
        { label: 'Operating Income', kind: 'section' },
        { label: 'Sales', depth: 1 },
        { label: 'Food and drinks', values: v((p) => p.revenue.food), depth: 2 },
        { label: 'Delivery fees', values: v((p) => p.revenue.delivery), depth: 2 },
        { label: 'Total for Sales', values: v((p) => p.revenue.total), kind: 'total', depth: 1 },
        { label: 'Total for Operating Income', values: v((p) => p.revenue.total), kind: 'total' },
        { label: 'Cost of Goods Sold', kind: 'section' },
        // With stock counted (Stock): opening stock + purchases − closing stock.
        ...(cols.some((p) => p.costOfSales.openingStock || p.costOfSales.closingStock)
          ? [
              {
                label: 'Opening stock',
                values: v((p) => p.costOfSales.openingStock),
                depth: 1,
              },
              { label: 'Purchases', depth: 1 },
              ...byKeyRows(
                cols.map((p) => p.costOfSales.byCategory),
                PURCHASE_CATEGORY_NAMES,
                2,
              ),
              {
                label: 'Less: closing stock',
                values: v((p) => -p.costOfSales.closingStock),
                depth: 1,
              },
            ]
          : byKeyRows(
              cols.map((p) => p.costOfSales.byCategory),
              PURCHASE_CATEGORY_NAMES,
              1,
            )),
        {
          label: 'Total for Cost of Goods Sold',
          values: v((p) => p.costOfSales.total),
          kind: 'total',
        },
        { label: 'Gross Profit', values: v((p) => p.grossProfit), kind: 'grand' },
        { label: 'Operating Expense', kind: 'section' },
        { label: 'Rider commission', values: v((p) => p.operating.riderCommission), depth: 1 },
        {
          label: 'Delivery fees paid to riders',
          values: v((p) => p.operating.riderDeliveryFees),
          depth: 1,
        },
        ...byKeyRows(
          cols.map((p) => p.operating.expenses),
          EXPENSE_CATEGORY_NAMES,
          1,
        ),
        ...(cols.some((p) => p.operating.fromTills)
          ? [
              {
                label: 'Petty cash (paid from the tills)',
                values: v((p) => p.operating.fromTills),
                depth: 1,
              },
            ]
          : []),
        {
          label: 'Total for Operating Expense',
          values: v((p) => p.operating.total),
          kind: 'total',
        },
        { label: 'Operating Profit', values: v((p) => p.netProfit), kind: 'grand' },
        { label: 'Non Operating Income', kind: 'section' },
        { label: 'Total for Non Operating Income', values: v(() => 0), kind: 'total' },
        { label: 'Non Operating Expense', kind: 'section' },
        { label: 'Total for Non Operating Expense', values: v(() => 0), kind: 'total' },
        { label: 'Net Profit/Loss', values: v((p) => p.netProfit), kind: 'grand' },
      ]
    : [];
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <PrintButton />
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && (
        <Statement
          title={`Profit and Loss${branch ? ` · ${branch}` : ''}`}
          subtitle="Basis: Accrual"
          columns={[rangeLabel(data.previousRange), rangeLabel(data.range)]}
          lines={lines}
          note="Sales count orders delivered or served in the period. Cost of goods sold is opening stock + purchases − closing stock (the stock counts; with no counts, stock bought is a cost when bought); rider pay is an expense when the order is delivered; equipment is a fixed asset (Balance Sheet), not an expense."
        />
      )}
    </div>
  );
}

type RefundRow = {
  id: string;
  code: string;
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

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function BalanceSheet() {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const today = todayIn(timezone);
  const [day, setDay] = useState(today);
  const [compareDay, setCompareDay] = useState(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`);
  const branches = useBranchOptions();
  const [branchId, setBranchId] = useState('');
  const { data, error, loading, reload } = useCloud<{
    day: string;
    compareDay: string;
    fiscalYearStart: number;
    yearStart: string;
    opening: { cash: number; bank: number };
    openingSet: boolean;
    sheet: Position;
    compare: Position;
    refunds?: { owed: RefundRow[]; cleared: RefundRow[] };
  }>('getBalanceSheet', { day, compareDay, ...(branchId && { branchId }) });
  const [openCash, setOpenCash] = useState('');
  const [openBank, setOpenBank] = useState('');
  const [yearStart, setYearStart] = useState('1');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (!data) return;
    setOpenCash(String(data.opening.cash));
    setOpenBank(String(data.opening.bank));
    setYearStart(String(data.fiscalYearStart));
  }, [data]);
  const branch = branches.find((b) => b.id === branchId)?.name;
  const cols = data ? [data.compare, data.sheet] : [];
  const v = (pick: (p: Position) => number) => cols.map(pick);
  const label = (d: string) =>
    `As of ${formatDate(`${d}T12:00:00Z`, 'UTC', { dateStyle: 'medium' })}`;
  const lines: Line[] = data
    ? [
        { label: 'Assets', kind: 'section' },
        { label: 'Current Assets', depth: 1 },
        { label: 'Cash and Cash Equivalents', depth: 2 },
        { label: 'Cash (tills)', values: v((p) => p.assets.tills), depth: 3 },
        { label: 'Mobile money and bank', values: v((p) => p.assets.bank), depth: 3 },
        {
          label: 'Total for Cash and Cash Equivalents',
          values: v((p) => p.assets.cash),
          kind: 'total',
          depth: 2,
        },
        {
          label: 'Accounts Receivable (sales not yet received)',
          values: v((p) => p.assets.receivable),
          depth: 2,
        },
        {
          label: 'Inventory (stock at its latest count)',
          values: v((p) => p.assets.inventory ?? 0),
          depth: 2,
        },
        {
          label: 'Total for Current Assets',
          values: v((p) => p.assets.current),
          kind: 'total',
          depth: 1,
        },
        { label: 'Fixed Assets', depth: 1 },
        { label: 'Furniture and Equipment', values: v((p) => p.assets.equipment), depth: 2 },
        {
          label: 'Total for Fixed Assets',
          values: v((p) => p.assets.fixed),
          kind: 'total',
          depth: 1,
        },
        { label: 'Total for Assets', values: v((p) => p.assets.total), kind: 'grand' },
        { label: 'Liabilities & Equities', kind: 'section' },
        { label: 'Liabilities', depth: 1 },
        { label: 'Current Liabilities', depth: 2 },
        {
          label: 'Accounts Payable (unpaid purchases)',
          values: v((p) => p.liabilities.suppliers),
          depth: 3,
        },
        { label: 'Other Current Liabilities', depth: 3 },
        { label: 'Rider pay owed', values: v((p) => p.liabilities.riders), depth: 4 },
        {
          label: 'Customer vouchers (refunds owed)',
          values: v((p) => p.liabilities.refunds),
          depth: 4,
        },
        {
          label: 'Total for Current Liabilities',
          values: v((p) => p.liabilities.current),
          kind: 'total',
          depth: 2,
        },
        {
          label: 'Total for Liabilities',
          values: v((p) => p.liabilities.total),
          kind: 'total',
          depth: 1,
        },
        { label: 'Equities', depth: 1 },
        { label: 'Opening Balance Equity', values: v((p) => p.equity.opening), depth: 2 },
        { label: 'Retained Earnings', values: v((p) => p.equity.retained), depth: 2 },
        { label: 'Current Year Earnings', values: v((p) => p.equity.currentYear), depth: 2 },
        ...(cols.some((p) => p.equity.other)
          ? [
              {
                label: 'Cash Over and Short (till and cash differences)',
                values: v((p) => p.equity.other),
                depth: 2,
              },
            ]
          : []),
        {
          label: 'Total for Equities',
          values: v((p) => p.equity.total),
          kind: 'total',
          depth: 1,
        },
        {
          label: 'Total for Liabilities & Equities',
          values: v((p) => p.liabilities.total + p.equity.total),
          kind: 'grand',
        },
      ]
    : [];
  const saveOpening = async () => {
    setSaving(true);
    setSaveError('');
    setSaved('');
    try {
      await Parse.Cloud.run('saveOpeningBalance', {
        cash: Number(openCash) || 0,
        bank: Number(openBank) || 0,
        fiscalYearStart: Number(yearStart) || 1,
      });
      setSaved('Saved.');
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={loading ? 'busy' : ''}>
      <div className="filter-bar no-print">
        <label>
          <span>As of</span>
          <input
            type="date"
            value={day}
            max={today}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        </label>
        <label>
          <span>Compare with</span>
          <input
            type="date"
            value={compareDay}
            max={today}
            onChange={(e) => e.target.value && setCompareDay(e.target.value)}
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
      {data && !branchId && (
        <details className="admin-panel opening-panel no-print" open={!data.openingSet}>
          <summary>Opening balances and financial year</summary>
          <p className="muted small">
            The cash and the mobile money / bank the restaurant had when it started using RelayEats,
            and the month its financial year starts (Retained Earnings are the profit of earlier
            years).
          </p>
          <form
            className="opening-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveOpening();
            }}
          >
            <label>
              Cash
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={openCash}
                onChange={(e) => setOpenCash(e.target.value)}
              />
            </label>
            <label>
              Mobile money and bank
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={openBank}
                onChange={(e) => setOpenBank(e.target.value)}
              />
            </label>
            <label>
              Financial year starts
              <select value={yearStart} onChange={(e) => setYearStart(e.target.value)}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={saving}>Save</button>
            {saveError && <span className="form-error">{saveError}</span>}
            {saved && <span className="form-success">{saved}</span>}
          </form>
        </details>
      )}
      {data && (
        <Statement
          title={`Balance Sheet${branch ? ` · ${branch}` : ''}`}
          subtitle={
            <>
              Basis: Accrual · financial year from{' '}
              {formatDate(`${data.yearStart}T12:00:00Z`, 'UTC', { dateStyle: 'medium' })}
            </>
          }
          columns={[label(data.compareDay), label(data.day)]}
          lines={lines}
          note={
            <>
              Total assets equal total liabilities and equities. Cash and mobile money / bank are
              worked out from the opening balances and what came in and went out (by how it was
              paid); check them against your till counts and statements.
              {branchId && ' A branch’s balance sheet has no opening balances.'}
            </>
          }
        />
      )}
      {data?.refunds && (data.refunds.owed.length > 0 || data.refunds.cleared.length > 0) && (
        <article className="admin-panel statement">
          <h3>Customer vouchers (refunds owed)</h3>
          <p className="muted small">
            Money paid for orders that were then cancelled, kept as the customer&apos;s vouchers:
            owed until refunded (less the charges for sending it) or spent on an order that was
            delivered. Manage them under Refunds &amp; vouchers.
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

const FLOW_LINES: Record<string, string> = {
  receivable: 'Accounts Receivable',
  inventory: 'Inventory (stock)',
  payable: 'Accounts Payable',
  riders: 'Rider pay owed',
  vouchers: 'Customer vouchers (refunds owed)',
  cash_over_short: 'Cash over and short',
  equipment: 'Furniture and Equipment',
  owner: 'Owner’s capital (opening balances)',
};

export function CashFlowStatement() {
  const [filters, setFilters] = useFilters('thisMonth');
  const branches = useBranchOptions();
  const { data, error, loading } = useCloud<{
    range: { from: string; to: string };
    previousRange: { from: string; to: string };
    current: Flow;
    previous: Flow;
  }>('getCashFlow', filterParams(filters));
  const branch = branches.find((b) => b.id === filters.branchId)?.name;
  const cols = data ? [data.previous, data.current] : [];
  const v = (pick: (f: Flow) => number) => cols.map(pick);
  const linesOf = (pick: (f: Flow) => { key: string; amount: number }[], depth: number): Line[] =>
    (cols[1] ? pick(cols[1]) : []).map((line, i) => ({
      label: FLOW_LINES[line.key] || line.key,
      values: cols.map((f) => pick(f)[i]?.amount ?? 0),
      depth,
    }));
  const lines: Line[] = data
    ? [
        { label: 'Beginning Cash Balance', values: v((f) => f.beginning), kind: 'grand' },
        { label: 'Cash Flow from Operating Activities', kind: 'section' },
        { label: 'Net Income', values: v((f) => f.operating.netIncome), depth: 1 },
        { label: 'Adjustments for changes in what is owed', depth: 1 },
        ...linesOf((f) => f.operating.lines, 2),
        {
          label: 'Net cash provided by Operating Activities',
          values: v((f) => f.operating.total),
          kind: 'total',
        },
        { label: 'Cash Flow from Investing Activities', kind: 'section' },
        ...linesOf((f) => f.investing.lines, 1),
        {
          label: 'Net cash provided by Investing Activities',
          values: v((f) => f.investing.total),
          kind: 'total',
        },
        { label: 'Cash Flow from Financing Activities', kind: 'section' },
        ...linesOf((f) => f.financing.lines, 1),
        {
          label: 'Net cash provided by Financing Activities',
          values: v((f) => f.financing.total),
          kind: 'total',
        },
        { label: 'Net Change in cash', values: v((f) => f.netChange), kind: 'total' },
        { label: 'Ending Cash Balance', values: v((f) => f.ending), kind: 'grand' },
      ]
    : [];
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <PrintButton />
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && (
        <Statement
          title={`Cash Flow Statement${branch ? ` · ${branch}` : ''}`}
          subtitle="Indirect method · cash and mobile money / bank"
          columns={[rangeLabel(data.previousRange), rangeLabel(data.range)]}
          lines={lines}
          note="Net income adjusted for what changed in what is owed to and by the restaurant. A rise in receivables or stock uses cash (shown negative); a rise in payables, rider pay or vouchers owed keeps cash. Ending cash equals cash and cash equivalents on the Balance Sheet."
        />
      )}
    </div>
  );
}

type RatioMonth = {
  month: string;
  sales: number;
  grossProfit: number;
  netProfit: number;
  operatingCost: number;
  currentAssets: number;
  currentLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  equity: number;
  receivable: number;
  inventory: number;
  ratios: Record<RatioKey, number | null>;
};
type RatioKey =
  | 'grossProfit'
  | 'netProfit'
  | 'operatingCost'
  | 'current'
  | 'acidTest'
  | 'debt'
  | 'debtToEquity'
  | 'receivableTurnover';

// Each ratio: what it is made of, and whether it reads as a percentage.
type Ratio = {
  key: RatioKey;
  label: string;
  num: [string, (m: RatioMonth) => number];
  den: [string, (m: RatioMonth) => number];
  percent?: boolean;
  help: string;
};
const RATIOS: Ratio[] = [
  {
    key: 'grossProfit',
    label: 'Gross Profit Ratio',
    num: ['Gross profit', (m) => m.grossProfit],
    den: ['Net sales', (m) => m.sales],
    percent: true,
    help: 'Gross profit ÷ net sales: what is left of sales after stock bought.',
  },
  {
    key: 'netProfit',
    label: 'Net Profit Ratio',
    num: ['Net profit', (m) => m.netProfit],
    den: ['Net sales', (m) => m.sales],
    percent: true,
    help: 'Net profit ÷ net sales.',
  },
  {
    key: 'operatingCost',
    label: 'Operating Cost Ratio',
    num: ['Operating expenses', (m) => m.operatingCost],
    den: ['Net sales', (m) => m.sales],
    percent: true,
    help: 'Operating expenses ÷ net sales.',
  },
  {
    key: 'current',
    label: 'Current Ratio',
    num: ['Current assets', (m) => m.currentAssets],
    den: ['Current liabilities', (m) => m.currentLiabilities],
    help: 'Current assets ÷ current liabilities at the month’s end: above 1, the restaurant can pay what it owes soon.',
  },
  {
    key: 'acidTest',
    label: 'Acid Test Ratio',
    num: ['Quick assets', (m) => m.currentAssets - (m.inventory || 0)],
    den: ['Current liabilities', (m) => m.currentLiabilities],
    help: 'Quick assets (current assets less stock) ÷ current liabilities: what the restaurant can pay soon without selling its stock. With no stock counted it equals the current ratio.',
  },
  {
    key: 'debt',
    label: 'Debt Ratio',
    num: ['Total liabilities', (m) => m.totalLiabilities],
    den: ['Total assets', (m) => m.totalAssets],
    help: 'Total liabilities ÷ total assets.',
  },
  {
    key: 'debtToEquity',
    label: 'Debt To Equity Ratio',
    num: ['Total liabilities', (m) => m.totalLiabilities],
    den: ['Equity', (m) => m.equity],
    help: 'Total liabilities ÷ equity.',
  },
  {
    key: 'receivableTurnover',
    label: 'Receivable Turnover Ratio',
    num: ['Net sales', (m) => m.sales],
    den: ['Receivables (month end)', (m) => m.receivable],
    help: 'Net sales ÷ average receivables: how many times a month sales due are collected.',
  },
];

const showRatio = (ratio: Ratio, value: number | null) =>
  value === null ? '—' : ratio.percent ? `${Math.round(value * 100)}%` : value.toFixed(2);

// Compared, every ratio is on one chart and one axis as its plain value:
// a percentage ratio is plotted as a fraction of 1 (14% at 0.14), the hover
// still gives it as a percentage. The acid test comes last (keeping the
// others' colours) and only once stock is counted: before that it is the
// current ratio and its line would hide under it (the table still has it).
const COMPARE: RatioKey[] = [
  'grossProfit',
  'netProfit',
  'operatingCost',
  'current',
  'debt',
  'debtToEquity',
  'receivableTurnover',
  'acidTest',
];

// One line per ratio, month by month. Months with no denominator are gaps.
// Colours follow the ratio's place in its chart, never its value.
function ratioChart(rows: RatioMonth[], list: Ratio[], percent: boolean, narrow: boolean) {
  const x = rows.map((m) => bucketLabel(m.month, 'month', narrow));
  const data: Data[] = list.map((ratio, i) => ({
    type: 'scatter',
    mode: 'lines+markers',
    name: ratio.label.replace(/ Ratio$/, ''),
    x,
    y: rows.map((m) => {
      const v = m.ratios[ratio.key];
      return v === null ? null : percent ? Math.round(v * 1000) / 10 : v;
    }),
    connectgaps: false,
    line: { color: SERIES[i], width: 2, shape: 'linear' },
    marker: { color: SERIES[i], size: 8, line: { color: '#ffffff', width: 2 } },
    customdata: rows.map((m) => [
      showRatio(ratio, m.ratios[ratio.key]),
      bucketLabel(m.month, 'month'),
    ]),
    hovertemplate:
      list.length > 1
        ? `${ratio.label.replace(/ Ratio$/, '')}: <b>%{customdata[0]}</b><extra></extra>`
        : '<b>%{customdata[0]}</b><br>%{customdata[1]}<extra></extra>',
  }));
  const layout: Partial<Layout> = {
    hovermode: list.length > 1 ? 'x unified' : 'x',
    yaxis: percent ? { tickformat: '~r', ticksuffix: '%' } : { tickformat: '.2~f' },
    // Two or more lines: a legend above the plot. Tapping a name hides or
    // shows that line (e.g. a turnover far above the others).
    ...(list.length > 1 && {
      showlegend: true,
      legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 12 } },
      margin: { l: 8, r: 12, t: 36, b: 8 },
    }),
  };
  return { data, layout };
}

export function PerformanceRatios() {
  const money = useMoney();
  const branches = useBranchOptions();
  const [branchId, setBranchId] = useState('');
  const [months, setMonths] = useState(12);
  const [key, setKey] = useState<RatioKey | 'all'>('all');
  const { data, error, loading } = useCloud<{ months: RatioMonth[] }>('getPerformanceRatios', {
    months,
    ...(branchId && { branchId }),
  });
  const ratio = key === 'all' ? null : RATIOS.find((r) => r.key === key)!;
  const rows = useMemo(() => data?.months ?? [], [data]);
  const avg = (k: RatioKey, n: number) => {
    const values = rows
      .slice(-n)
      .map((m) => m.ratios[k])
      .filter((x): x is number => x !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const last = rows.at(-1);
  const narrow = useDevice() === 'phone';
  const chart = useMemo(
    () =>
      ratio
        ? ratioChart(rows, [ratio], !!ratio.percent, narrow)
        : ratioChart(
            rows,
            COMPARE.filter((k) => k !== 'acidTest' || rows.some((m) => m.inventory > 0)).map((k) =>
              RATIOS.find((r) => r.key === k)!,
            ),
            false,
            narrow,
          ),
    [rows, ratio, narrow],
  );
  return (
    <div className={loading ? 'busy' : ''}>
      <div className="filter-bar no-print">
        <label>
          <span>Ratio</span>
          <select value={key} onChange={(e) => setKey(e.target.value as RatioKey | 'all')}>
            <option value="all">All ratios (compare)</option>
            {RATIOS.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Months</span>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[6, 12, 24].map((n) => (
              <option key={n} value={n}>
                Last {n} months
              </option>
            ))}
          </select>
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
      {data && last && !ratio && (
        <article className="admin-panel statement">
          <header className="statement-head">
            <h2>Business Performance Ratios</h2>
            <p className="muted small">
              Every ratio month by month on one scale: percentage ratios are drawn as their plain
              value (14% at 0.14), hover to read each in its usual form. Tap a name in the legend to
              hide or show its line. Pick one ratio above for its numbers and averages.
            </p>
          </header>
          <Chart
            data={chart.data}
            layout={chart.layout}
            label="All business performance ratios by month"
            busy={loading}
            height={360}
          />
          <div className="fin-scroll">
            <table className="data ratio-compare">
              <thead>
                <tr>
                  <th>Month</th>
                  {RATIOS.map((r) => (
                    <th key={r.key} className="num">
                      {r.label.replace(/ Ratio$/, '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.month}>
                    <td>{bucketLabel(m.month, 'month')}</td>
                    {RATIOS.map((r) => (
                      <td key={r.key} className="num">
                        {showRatio(r, m.ratios[r.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
      {data && last && ratio && (
        <article className="admin-panel statement">
          <header className="statement-head">
            <h2>{ratio.label}</h2>
            <p className="muted small">{ratio.help}</p>
          </header>
          <div className="ratio-tiles">
            <div>
              <small>For {bucketLabel(last.month, 'month')}</small>
              <b>{showRatio(ratio, last.ratios[ratio.key])}</b>
            </div>
            {[3, 6, 12]
              .filter((n) => n <= rows.length)
              .map((n) => (
                <div key={n}>
                  <small>Average, last {n} months</small>
                  <b>{showRatio(ratio, avg(ratio.key, n))}</b>
                </div>
              ))}
          </div>
          <Chart
            data={chart.data}
            layout={chart.layout}
            label={`${ratio.label} by month`}
            busy={loading}
          />
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">{ratio.num[0]}</th>
                  <th className="num">{ratio.den[0]}</th>
                  <th className="num">{ratio.label}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.month}>
                    <td>{bucketLabel(m.month, 'month')}</td>
                    <td className="num">{money(ratio.num[1](m))}</td>
                    <td className="num">{money(ratio.den[1](m))}</td>
                    <td className="num strong">{showRatio(ratio, m.ratios[ratio.key])}</td>
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
