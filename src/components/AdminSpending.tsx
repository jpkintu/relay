import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { todayIn } from '../lib/range';
import { PURCHASE_CATEGORY_NAMES } from '../lib/spendingNames';
import { AdminStock, useStockItems } from './AdminStock';
import {
  FilterBar,
  Stat,
  filterParams,
  useBranchOptions,
  useCloud,
  useFilters,
  type BranchOption,
} from './reports/common';

// Owner and finance: purchases from suppliers, running expenses, the
// suppliers themselves (cloud/spending.js), and stock (AdminStock).

export const METHOD_NAMES: Record<string, string> = {
  cash: 'Cash',
  mobile_money: 'Mobile money',
  bank: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
};
export { PURCHASE_CATEGORY_NAMES };
export const EXPENSE_CATEGORY_NAMES: Record<string, string> = {
  rent: 'Rent',
  salaries: 'Salaries & wages',
  utilities: 'Utilities (power, water, internet)',
  transport: 'Transport',
  marketing: 'Marketing',
  repairs: 'Repairs & maintenance',
  equipment: 'Small equipment',
  licences_taxes: 'Licences & taxes',
  bank_charges: 'Bank & mobile money charges',
  other: 'Other',
};

type Supplier = {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  tin: string;
  notes: string;
  active: boolean;
  owed: number;
};
type Line = {
  description: string;
  quantity: number;
  unit?: string;
  unitCost: number;
  total: number;
};
type Purchase = {
  id: string;
  code: string;
  day: string;
  supplier: string;
  supplierId: string;
  branchId: string;
  category: string;
  lines: Line[];
  total: number;
  paid: number;
  owed: number;
  status: 'paid' | 'partial' | 'unpaid' | 'void';
  invoice: string;
  notes: string;
  payments: { amount: number; method: string; day: string; by: string }[];
  recordedBy: string;
  voidReason: string;
};
type Expense = {
  id: string;
  code: string;
  day: string;
  category: string;
  description: string;
  amount: number;
  method: string;
  branchId: string;
  payee: string;
  reference: string;
  status: 'recorded' | 'void';
  recordedBy: string;
  voidReason: string;
};

const TABS = [
  ['purchases', 'Purchases'],
  ['expenses', 'Expenses'],
  ['stock', 'Stock'],
  ['suppliers', 'Suppliers'],
] as const;
type Tab = (typeof TABS)[number][0];

const STATUS_TONE: Record<string, string> = {
  paid: 'good',
  partial: 'warn',
  unpaid: 'bad',
  void: '',
};
const STATUS_NAME: Record<string, string> = {
  paid: 'Paid',
  partial: 'Part paid',
  unpaid: 'Not paid',
  void: 'Voided',
};

const branchName = (branches: BranchOption[], id: string) =>
  branches.find((b) => b.id === id)?.name || '';

async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
  return Parse.Cloud.run(name, params) as Promise<T>;
}

export function AdminSpending() {
  // ?tab=stock opens a tab (the low stock notification links there).
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(([id]) => id === asked) ? (asked as Tab) : 'purchases';
  });
  return (
    <div className="report spending">
      <div
        className="filter-toggle spending-tabs"
        role="tablist"
        aria-label="Purchases and expenses"
      >
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
      {tab === 'purchases' && <Purchases />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'stock' && <AdminStock />}
      {tab === 'suppliers' && <Suppliers />}
    </div>
  );
}

function useSuppliers() {
  return useCloud<{ suppliers: Supplier[] }>('listSuppliers', {});
}

// ---------------------------------------------------------------------------

function Purchases() {
  const money = useMoney();
  const [filters, setFilters] = useFilters('last30');
  const [owedOnly, setOwedOnly] = useState(false);
  const branches = useBranchOptions();
  const suppliers = useSuppliers();
  const { data, error, loading, reload } = useCloud<{
    purchases: Purchase[];
    summary: { count: number; total: number; paid: number; owed: number };
  }>('listPurchases', filterParams(filters, owedOnly ? { status: 'owed' } : {}));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const s = data?.summary;
  const done = () => {
    reload();
    suppliers.reload();
  };

  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={owedOnly}
            onChange={(e) => setOwedOnly(e.target.checked)}
          />{' '}
          Still owed only
        </label>
        <button className="filter-action" onClick={() => setAdding((v) => !v)}>
          <Plus size={16} /> Record a purchase
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {adding && (
        <PurchaseForm
          suppliers={(suppliers.data?.suppliers ?? []).filter((x) => x.active)}
          branches={branches.filter((b) => b.active)}
          onDone={() => {
            setAdding(false);
            done();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {s && (
        <div className="stat-grid">
          <Stat label="Purchases" value={money(s.total)} note={`${s.count} in these dates`} />
          <Stat label="Paid" value={money(s.paid)} />
          <Stat label="Owed to suppliers" value={money(s.owed)} note="On these purchases" />
          <Stat
            label="Owed in total"
            value={money((suppliers.data?.suppliers ?? []).reduce((n, x) => n + x.owed, 0))}
            note="All suppliers, all dates"
          />
        </div>
      )}
      <section className="admin-panel admin-section-panel">
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Purchase</th>
                <th>Supplier</th>
                <th>Kind</th>
                <th className="num">Total</th>
                <th className="num">Owed</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.purchases ?? []).map((row) => (
                <PurchaseRow
                  key={row.id}
                  row={row}
                  branch={branches.length > 1 ? branchName(branches, row.branchId) : ''}
                  open={open === row.id}
                  onToggle={() => setOpen(open === row.id ? null : row.id)}
                  onDone={done}
                />
              ))}
              {!data?.purchases.length && !loading && (
                <tr>
                  <td colSpan={7} className="empty-orders">
                    No purchases in these dates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PurchaseRow({
  row,
  branch,
  open,
  onToggle,
  onDone,
}: {
  row: Purchase;
  branch: string;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (name: string, params: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await call(name, params);
      setAmount('');
      setReason('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <tr className={row.status === 'void' ? 'inactive' : ''}>
        <td data-label="Purchase">
          <span className="code">{row.code}</span>
          <small>
            {row.day}
            {branch && ` · ${branch}`}
            {row.invoice && ` · invoice ${row.invoice}`}
          </small>
        </td>
        <td data-label="Supplier">{row.supplier}</td>
        <td data-label="Kind">{PURCHASE_CATEGORY_NAMES[row.category] || row.category}</td>
        <td data-label="Total" className="num">
          {money(row.total)}
        </td>
        <td data-label="Owed" className="num">
          {row.owed ? money(row.owed) : '—'}
        </td>
        <td data-label="Status">
          <span className={`status-pill ${STATUS_TONE[row.status] || ''}`}>
            {STATUS_NAME[row.status]}
          </span>
        </td>
        <td className="actions-cell">
          <button className="link-button" onClick={onToggle}>
            {open ? 'Close' : 'Details'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={7}>
            <div className="spending-detail">
              <div>
                <p className="mini-table-title">Lines</p>
                <div className="mini-table">
                  {row.lines.map((line, i) => (
                    <div key={i}>
                      <span>{line.description}</span>
                      <span>
                        {line.quantity}
                        {line.unit ? ` ${line.unit}` : ''} × {money(line.unitCost)}
                      </span>
                      <strong>{money(line.total)}</strong>
                    </div>
                  ))}
                </div>
                {!!row.payments.length && (
                  <>
                    <p className="mini-table-title">Payments</p>
                    <div className="mini-table">
                      {row.payments.map((p, i) => (
                        <div key={i}>
                          <span>{p.day}</span>
                          <span>
                            {METHOD_NAMES[p.method] || p.method}
                            {p.by && ` · ${p.by}`}
                          </span>
                          <strong>{money(p.amount)}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {row.notes && <p className="muted small">{row.notes}</p>}
                <p className="muted small">
                  Recorded by {row.recordedBy || '—'}
                  {row.voidReason && ` · voided: ${row.voidReason}`}
                </p>
              </div>
              {row.status !== 'void' && (
                <div className="spending-actions">
                  {row.owed > 0 && (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act('payPurchase', {
                          purchaseId: row.id,
                          amount: Number(amount),
                          method,
                        });
                      }}
                    >
                      <input
                        type="number"
                        min="1"
                        inputMode="numeric"
                        aria-label="Amount paid"
                        placeholder={`Pay up to ${row.owed}`}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                      <MethodSelect value={method} onChange={setMethod} />
                      <button disabled={busy || !Number(amount)}>Record payment</button>
                    </form>
                  )}
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act('voidPurchase', { id: row.id, reason });
                    }}
                  >
                    <input
                      aria-label="Why void it"
                      placeholder="Why void it (e.g. entered twice)"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button className="danger-button" disabled={busy || reason.trim().length < 3}>
                      Void
                    </button>
                  </form>
                  {error && <p className="form-error">{error}</p>}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label="Paid by" value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.entries(METHOD_NAMES).map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}

function BranchField({
  branches,
  value,
  onChange,
}: {
  branches: BranchOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (branches.length < 2) return null;
  return (
    <label className="setup-field">
      Branch
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Main branch</option>
        {branches
          .filter((b) => !b.main)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
      </select>
    </label>
  );
}

const emptyLine = () => ({ description: '', quantity: '1', unit: '', unitCost: '', itemId: '' });

function PurchaseForm({
  suppliers,
  branches,
  onDone,
  onCancel,
}: {
  suppliers: Supplier[];
  branches: BranchOption[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [day, setDay] = useState(todayIn(timezone));
  const [supplierId, setSupplierId] = useState('');
  const [category, setCategory] = useState('food');
  const [branchId, setBranchId] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('cash');
  const [invoice, setInvoice] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A line whose description is a stock item's name is linked to it.
  const stock = (useStockItems().data?.items ?? []).filter((i) => i.active);
  const describe = (i: number, description: string) => {
    const item = stock.find((x) => x.name.toLowerCase() === description.trim().toLowerCase());
    setLines((all) =>
      all.map((l, j) =>
        j !== i
          ? l
          : item
            ? {
                ...l,
                description,
                itemId: item.id,
                unit: l.unit || item.unit,
                unitCost: l.unitCost || (item.unitCost ? String(item.unitCost) : ''),
              }
            : { ...l, description, itemId: '' },
      ),
    );
  };
  const lineTotal = (l: ReturnType<typeof emptyLine>) =>
    Math.round((Number(l.quantity) || 0) * (Number(l.unitCost) || 0));
  const total = lines.reduce((n, l) => n + lineTotal(l), 0);
  const setLine = (i: number, patch: Partial<ReturnType<typeof emptyLine>>) =>
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await call('recordPurchase', {
        day,
        supplierId,
        category,
        ...(branchId && { branchId }),
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unit: l.unit,
            unitCost: Number(l.unitCost) || 0,
            ...(l.itemId && { itemId: l.itemId }),
          })),
        paid: paid === '' ? 0 : Number(paid),
        method,
        invoice,
        notes,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the purchase');
    } finally {
      setBusy(false);
    }
  };

  if (!suppliers.length)
    return (
      <p className="setup-notice">
        Add a supplier first (the Suppliers tab), then record what you bought from them.
      </p>
    );
  return (
    <form
      className="admin-panel spending-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>Record a purchase</h2>
      <div className="spending-fields">
        <label className="setup-field">
          Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choose…</option>
            {suppliers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="setup-field">
          Date
          <input
            type="date"
            value={day}
            max={todayIn(timezone)}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        <label className="setup-field">
          Kind
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(PURCHASE_CATEGORY_NAMES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <BranchField branches={branches} value={branchId} onChange={setBranchId} />
        <label className="setup-field">
          Invoice / receipt number (optional)
          <input value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={60} />
        </label>
      </div>
      <div className="purchase-lines">
        <div className="purchase-line head" aria-hidden>
          <span>What</span>
          <span>Quantity</span>
          <span>Unit</span>
          <span>Unit cost</span>
          <span className="num">Line total</span>
          <span />
        </div>
        {lines.map((l, i) => (
          <div className="purchase-line" key={i}>
            <input
              aria-label="What"
              placeholder="e.g. Tomatoes"
              list="stock-item-names"
              className={l.itemId ? 'stock-linked' : ''}
              title={l.itemId ? 'A stock item: counts towards what is on hand' : undefined}
              value={l.description}
              onChange={(e) => describe(i, e.target.value)}
            />
            <input
              aria-label="Quantity"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })}
            />
            <input
              aria-label="Unit"
              placeholder="kg, crate…"
              value={l.unit}
              onChange={(e) => setLine(i, { unit: e.target.value })}
            />
            <input
              aria-label="Unit cost"
              type="number"
              min="0"
              inputMode="numeric"
              value={l.unitCost}
              onChange={(e) => setLine(i, { unitCost: e.target.value })}
            />
            <span className="num">{money(lineTotal(l))}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Remove line"
              disabled={lines.length === 1}
              onClick={() => setLines((all) => all.filter((_, j) => j !== i))}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <datalist id="stock-item-names">
          {stock.map((x) => (
            <option key={x.id} value={x.name} />
          ))}
        </datalist>
        {lines.some((l) => l.itemId) && (
          <p className="muted small">Lines in blue are stock items: they add to what is on hand.</p>
        )}
        <button
          type="button"
          className="setup-secondary"
          onClick={() => setLines((all) => [...all, emptyLine()])}
        >
          <Plus size={16} /> Add a line
        </button>
        <p className="purchase-total">
          Total <strong>{money(total)}</strong>
        </p>
      </div>
      <div className="spending-fields">
        <label className="setup-field">
          Paid now (leave 0 if bought on credit)
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={paid}
            placeholder={String(total)}
            onChange={(e) => setPaid(e.target.value)}
          />
        </label>
        <label className="setup-field">
          Paid by
          <MethodSelect value={method} onChange={setMethod} />
        </label>
        <label className="setup-field full-row">
          Notes (optional)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="payment-actions">
        <button disabled={busy || !supplierId || !total}>Record purchase</button>
        <button type="button" className="setup-secondary" onClick={onCancel}>
          Cancel
        </button>
        {paid === '' && total > 0 && (
          <button type="button" className="link-button" onClick={() => setPaid(String(total))}>
            Paid in full
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Expenses() {
  const money = useMoney();
  const [filters, setFilters] = useFilters('last30');
  const [category, setCategory] = useState('');
  const branches = useBranchOptions();
  const { data, error, loading, reload } = useCloud<{
    expenses: Expense[];
    summary: { count: number; total: number; byCategory: { category: string; amount: number }[] };
  }>('listExpenses', filterParams(filters, category ? { category } : {}));
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState('');
  const s = data?.summary;

  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <label>
          <span>Kind</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All kinds</option>
            {Object.entries(EXPENSE_CATEGORY_NAMES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="filter-action" onClick={() => setAdding((v) => !v)}>
          <Plus size={16} /> Record an expense
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {adding && (
        <ExpenseForm
          branches={branches.filter((b) => b.active)}
          onDone={() => {
            setAdding(false);
            reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {s && (
        <div className="stat-grid">
          <Stat label="Expenses" value={money(s.total)} note={`${s.count} in these dates`} />
          {s.byCategory.slice(0, 3).map((c) => (
            <Stat
              key={c.category}
              label={EXPENSE_CATEGORY_NAMES[c.category] || c.category}
              value={money(c.amount)}
            />
          ))}
        </div>
      )}
      {actionError && <p className="ops-error">{actionError}</p>}
      <section className="admin-panel admin-section-panel">
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Expense</th>
                <th>Kind</th>
                <th>Paid to</th>
                <th>Paid by</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.expenses ?? []).map((row) => (
                <tr key={row.id} className={row.status === 'void' ? 'inactive' : ''}>
                  <td data-label="Expense">
                    <b>{row.description}</b>
                    <small>
                      {row.code} · {row.day}
                      {branches.length > 1 && ` · ${branchName(branches, row.branchId)}`}
                      {row.status === 'void' && ` · voided: ${row.voidReason}`}
                    </small>
                  </td>
                  <td data-label="Kind">{EXPENSE_CATEGORY_NAMES[row.category] || row.category}</td>
                  <td data-label="Paid to">
                    {row.payee || '—'}
                    {row.reference && <small>{row.reference}</small>}
                  </td>
                  <td data-label="Paid by">{METHOD_NAMES[row.method] || row.method}</td>
                  <td data-label="Amount" className="num">
                    {money(row.amount)}
                  </td>
                  <td className="actions-cell">
                    {row.status !== 'void' &&
                      (voiding === row.id ? (
                        <form
                          className="inline-form"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            setActionError('');
                            try {
                              await call('voidExpense', { id: row.id, reason });
                              setVoiding(null);
                              setReason('');
                              reload();
                            } catch (err) {
                              setActionError(
                                err instanceof Error ? err.message : 'Could not void it',
                              );
                            }
                          }}
                        >
                          <input
                            aria-label="Why void it"
                            placeholder="Why?"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                          <button className="danger-button" disabled={reason.trim().length < 3}>
                            Void
                          </button>
                        </form>
                      ) : (
                        <button className="link-button" onClick={() => setVoiding(row.id)}>
                          Void
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
              {!data?.expenses.length && !loading && (
                <tr>
                  <td colSpan={6} className="empty-orders">
                    No expenses in these dates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ExpenseForm({
  branches,
  onDone,
  onCancel,
}: {
  branches: BranchOption[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { timezone } = useConfig();
  const [day, setDay] = useState(todayIn(timezone));
  const [category, setCategory] = useState('rent');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="admin-panel spending-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await call('recordExpense', {
            day,
            category,
            description,
            amount: Number(amount),
            method,
            payee,
            reference,
            ...(branchId && { branchId }),
          });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not record the expense');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Record an expense</h2>
      <div className="spending-fields">
        <label className="setup-field">
          Kind
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(EXPENSE_CATEGORY_NAMES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setup-field">
          What for
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. October rent"
            maxLength={160}
          />
        </label>
        <label className="setup-field">
          Amount
          <input
            type="number"
            min="1"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="setup-field">
          Date
          <input
            type="date"
            value={day}
            max={todayIn(timezone)}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        <label className="setup-field">
          Paid by
          <MethodSelect value={method} onChange={setMethod} />
        </label>
        <label className="setup-field">
          Paid to (optional)
          <input value={payee} onChange={(e) => setPayee(e.target.value)} maxLength={80} />
        </label>
        <label className="setup-field">
          Reference (optional)
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Receipt or transaction ID"
            maxLength={60}
          />
        </label>
        <BranchField branches={branches} value={branchId} onChange={setBranchId} />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="payment-actions">
        <button disabled={busy || description.trim().length < 2 || !Number(amount)}>
          Record expense
        </button>
        <button type="button" className="setup-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

type SupplierDraft = Omit<Supplier, 'id' | 'owed' | 'active'> & { id?: string; active: boolean };
const EMPTY_SUPPLIER: SupplierDraft = {
  name: '',
  phone: '',
  email: '',
  address: '',
  tin: '',
  notes: '',
  active: true,
};

function Suppliers() {
  const money = useMoney();
  const { data, error, loading, reload } = useSuppliers();
  const [draft, setDraft] = useState<SupplierDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const field = (key: keyof SupplierDraft, label: string, props = {}) =>
    draft && (
      <label className="setup-field">
        {label}
        <input
          value={String(draft[key] ?? '')}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          {...props}
        />
      </label>
    );
  return (
    <div className={loading ? 'busy' : ''}>
      {error && <p className="ops-error">{error}</p>}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Suppliers <small>({data?.suppliers.length ?? 0})</small>
          </h2>
          <button
            className="setup-secondary branch-add"
            onClick={() => setDraft({ ...EMPTY_SUPPLIER })}
          >
            <Plus size={16} /> Add a supplier
          </button>
        </div>
        {draft && (
          <form
            className="branch-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setSaveError('');
              try {
                await call('saveSupplier', draft);
                setDraft(null);
                reload();
              } catch (err) {
                setSaveError(err instanceof Error ? err.message : 'Could not save');
              } finally {
                setBusy(false);
              }
            }}
          >
            {field('name', 'Name', { maxLength: 80, autoFocus: true })}
            {field('phone', 'Phone', { inputMode: 'tel', maxLength: 30 })}
            {field('email', 'Email', { type: 'email', maxLength: 120 })}
            {field('address', 'Address', { maxLength: 200 })}
            {field('tin', 'TIN (optional)', { maxLength: 20 })}
            {field('notes', 'Notes', { maxLength: 300 })}
            {draft.id && (
              <label className="setup-checkbox">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                />{' '}
                Active (archived suppliers keep their history but are not offered for new purchases)
              </label>
            )}
            {saveError && <p className="form-error">{saveError}</p>}
            <div className="payment-actions">
              <button disabled={busy || draft.name.trim().length < 2}>
                {draft.id ? 'Save supplier' : 'Add supplier'}
              </button>
              <button type="button" className="setup-secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Contact</th>
                <th className="num">Owed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.suppliers ?? []).map((x) => (
                <tr key={x.id} className={x.active ? '' : 'inactive'}>
                  <td data-label="Supplier">
                    <b>{x.name}</b>
                    {(x.tin || !x.active) && (
                      <small>
                        {x.tin && `TIN ${x.tin}`}
                        {!x.active && ' · archived'}
                      </small>
                    )}
                  </td>
                  <td data-label="Contact">
                    {[x.phone, x.email].filter(Boolean).join(' · ') || '—'}
                    {x.address && <small>{x.address}</small>}
                  </td>
                  <td data-label="Owed" className="num">
                    {x.owed ? money(x.owed) : '—'}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="setup-secondary"
                      onClick={() =>
                        setDraft({
                          id: x.id,
                          name: x.name,
                          phone: x.phone,
                          email: x.email,
                          address: x.address,
                          tin: x.tin,
                          notes: x.notes,
                          active: x.active,
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!data?.suppliers.length && !loading && (
                <tr>
                  <td colSpan={4} className="empty-orders">
                    No suppliers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
