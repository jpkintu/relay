import { useMemo, useState } from 'react';
import { Fragment } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { todayIn } from '../lib/range';
import { PURCHASE_CATEGORY_NAMES } from '../lib/spendingNames';
import { BranchSelect, Stat, useBranchOptions, useCloud } from './reports/common';

// Owner and finance: Purchases & expenses → Stock (cloud/stock.js). The
// stock items, what is on hand, and stock counts. Stock is kept by branch:
// each branch counts its own shelves and has its own quantities and reorder
// levels; the page opens on the main branch, and Whole restaurant shows
// every branch side by side. The latest count of each branch is the stock
// in the accounts (cost of goods sold, the balance sheet's inventory, the
// acid test).

export type StockItem = {
  id: string;
  name: string;
  unit: string;
  category: string;
  reorderLevel: number;
  unitCost: number;
  active: boolean;
  lastBoughtAt: string | null;
  onHand: number;
  counted: boolean;
  value: number;
  low: boolean;
  // Each branch's own: on hand, its reorder level, low.
  branches: {
    branchId: string;
    branch: string;
    onHand: number;
    counted: boolean;
    reorderLevel: number;
    low: boolean;
  }[];
};
type CountLine = {
  itemId: string;
  name: string;
  unit: string;
  quantity: number;
  unitCost: number;
  value: number;
};
type StockCount = {
  id: string;
  day: string;
  branchId: string;
  lines: CountLine[];
  total: number;
  notes: string;
  countedBy: string;
  status: 'counted' | 'void';
  voidReason: string;
};
type StockData = {
  items: StockItem[];
  counts: StockCount[];
  summary: { counted: number; lastCounted: string | null; low: number };
};

type ItemDraft = {
  id?: string;
  name: string;
  unit: string;
  category: string;
  reorderLevel: string;
  unitCost: string;
  active: boolean;
};
const EMPTY_ITEM: ItemDraft = {
  name: '',
  unit: '',
  category: 'food',
  reorderLevel: '',
  unitCost: '',
  active: true,
};

const qty = (n: number) => String(Math.round(n * 1000) / 1000);
const call = <T,>(name: string, params: Record<string, unknown>) =>
  Parse.Cloud.run(name, params) as Promise<T>;

// The stock items, for the purchase form (a line can name its item).
export function useStockItems() {
  return useCloud<StockData>('listStock', {});
}

export function AdminStock() {
  const money = useMoney();
  const { timezone } = useConfig();
  const branches = useBranchOptions();
  // The main branch until another one (or the whole restaurant) is picked.
  const [picked, setPicked] = useState<string | null>(null);
  const many = branches.length > 1;
  const branchId = picked ?? (branches.find((b) => b.main)?.id || '');
  const here = many && branchId ? branches.find((b) => b.id === branchId)?.name || '' : '';
  const { data, error, loading, reload } = useCloud<StockData>('listStock', {
    ...(branchId && { branchId }),
  });
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [counting, setCounting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const items = data?.items ?? [];
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || '';

  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await work();
      setDone(message);
      reload();
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={loading ? 'busy' : ''}>
      <div className="filter-bar no-print">
        <BranchSelect
          value={branchId}
          onChange={(id) => {
            setPicked(id);
            setCounting(false);
            setDraft(null);
          }}
          branches={branches}
          allLabel="Whole restaurant"
        />
        <button
          className="filter-action"
          onClick={() => {
            setDraft({ ...EMPTY_ITEM });
            setCounting(false);
          }}
        >
          <Plus size={16} /> Add a stock item
        </button>
        <button
          className="filter-action"
          disabled={!items.some((i) => i.active) || (many && !branchId)}
          title={many && !branchId ? 'Choose the branch to count' : undefined}
          onClick={() => {
            setCounting((v) => !v);
            setDraft(null);
          }}
        >
          <ClipboardList size={16} /> {here ? `Count ${here}` : 'Count stock'}
        </button>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {problem && <p className="ops-error">{problem}</p>}
      {done && <p className="form-success">{done}</p>}
      {data && (
        <div className="stat-grid">
          <Stat
            label={here ? `Stock value, ${here}` : 'Stock value'}
            value={money(data.summary.counted)}
            note={
              many && !branchId
                ? 'Every branch’s latest count'
                : 'At the latest count: in the accounts'
            }
          />
          <Stat
            label="Last counted"
            value={
              data.summary.lastCounted
                ? formatDate(data.summary.lastCounted, timezone, { dateStyle: 'medium' })
                : 'Never'
            }
            note="Count at least monthly"
          />
          <Stat
            label="Items low"
            value={String(data.summary.low)}
            note={many && !branchId ? 'In any branch' : 'At or under their reorder level'}
          />
        </div>
      )}
      {draft && (
        <ItemForm
          draft={draft}
          setDraft={setDraft}
          branch={here}
          busy={busy}
          onSave={async () => {
            const ok = await act(
              () =>
                call('saveStockItem', {
                  ...draft,
                  ...(here && { branchId }),
                  reorderLevel: Number(draft.reorderLevel) || 0,
                  unitCost: Number(draft.unitCost) || 0,
                }),
              `${draft.name.trim()} saved.`,
            );
            if (ok) setDraft(null);
          }}
        />
      )}
      {counting && (
        <CountForm
          items={items.filter((i) => i.active)}
          branchId={branchId}
          branch={here}
          busy={busy}
          onCancel={() => setCounting(false)}
          onSave={async (params) => {
            const ok = await act(
              () => call('recordStockCount', params),
              'Stock count saved: the accounts use it from that day.',
            );
            if (ok) setCounting(false);
          }}
        />
      )}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Stock items <small>({items.length})</small>
          </h2>
        </div>
        <p className="muted small">
          {many && !branchId
            ? 'Each branch keeps its own stock: pick a branch to count it or set its reorder levels. '
            : ''}
          On hand is the branch&apos;s latest count plus what its purchases naming the item brought
          in since. Sales do not take stock off: count regularly to keep it right.
        </p>
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">On hand</th>
                <th className="num">Reorder at</th>
                <th className="num">Cost per unit</th>
                <th className="num">Value</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={item.active ? '' : 'inactive'}>
                  <td data-label="Item">
                    <b>{item.name}</b>
                    <small className="block muted">
                      {PURCHASE_CATEGORY_NAMES[item.category] || item.category}
                      {!item.active && ' · archived'}
                    </small>
                  </td>
                  <td data-label="On hand" className="num">
                    {item.counted || item.onHand ? `${qty(item.onHand)} ${item.unit}` : '—'}
                    {many && !branchId && item.branches.length > 0 && (
                      <small className="block muted">
                        {item.branches.map((b, i) => (
                          <span key={b.branchId} className={b.low ? 'stock-low' : ''}>
                            {i > 0 && ' · '}
                            {b.branch || 'Main'}: {qty(b.onHand)}
                          </span>
                        ))}
                      </small>
                    )}
                  </td>
                  <td data-label="Reorder at" className="num">
                    {item.reorderLevel ? `${qty(item.reorderLevel)} ${item.unit}` : '—'}
                  </td>
                  <td data-label="Cost per unit" className="num">
                    {money(item.unitCost)}
                  </td>
                  <td data-label="Value" className="num">
                    {item.counted || item.onHand ? money(item.value) : '—'}
                  </td>
                  <td data-label="Status">
                    {!item.active ? (
                      <span className="status-pill">Archived</span>
                    ) : item.low ? (
                      <span className="status-pill bad">
                        {many && !branchId
                          ? `Low: ${item.branches
                              .filter((b) => b.low)
                              .map((b) => b.branch || 'Main')
                              .join(', ')}`
                          : 'Low'}
                      </span>
                    ) : item.counted || item.onHand ? (
                      <span className="status-pill good">In stock</span>
                    ) : (
                      <span className="status-pill">Not counted</span>
                    )}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="setup-secondary"
                      onClick={() => {
                        setCounting(false);
                        setDraft({
                          id: item.id,
                          name: item.name,
                          unit: item.unit,
                          category: item.category,
                          reorderLevel: item.reorderLevel ? String(item.reorderLevel) : '',
                          unitCost: String(item.unitCost),
                          active: item.active,
                        });
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!items.length && !loading && (
                <tr>
                  <td colSpan={7} className="empty-orders">
                    No stock items yet. Add what you keep (rice, cooking oil, sodas…), then count
                    them at the end of a day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>Stock counts</h2>
        </div>
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Day</th>
                {branches.length > 1 && <th>Branch</th>}
                <th className="num">Items</th>
                <th className="num">Value</th>
                <th>Counted by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.counts ?? []).map((count) => (
                <Fragment key={count.id}>
                  <tr className={count.status === 'void' ? 'inactive' : ''}>
                    <td data-label="Day">
                      <button
                        className="link-button"
                        aria-expanded={open === count.id}
                        onClick={() => setOpen(open === count.id ? null : count.id)}
                      >
                        {formatDate(`${count.day}T12:00:00Z`, 'UTC', { dateStyle: 'medium' })}
                      </button>
                      {count.status === 'void' && (
                        <small className="block muted">Voided: {count.voidReason}</small>
                      )}
                    </td>
                    {branches.length > 1 && (
                      <td data-label="Branch">{branchName(count.branchId)}</td>
                    )}
                    <td data-label="Items" className="num">
                      {count.lines.length}
                    </td>
                    <td data-label="Value" className="num">
                      {money(count.total)}
                    </td>
                    <td data-label="Counted by">{count.countedBy || '—'}</td>
                    <td className="actions-cell">
                      {count.status === 'counted' && (
                        <button
                          className="setup-secondary"
                          disabled={busy}
                          onClick={() => {
                            const reason = window.prompt('Why is this count wrong?');
                            if (reason && reason.trim().length >= 3)
                              void act(
                                () =>
                                  call('voidStockCount', { id: count.id, reason: reason.trim() }),
                                'Count voided.',
                              );
                          }}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                  {open === count.id && (
                    <tr className="detail-row">
                      <td colSpan={branches.length > 1 ? 6 : 5}>
                        <table className="data compact">
                          <tbody>
                            {count.lines.map((line) => (
                              <tr key={line.itemId}>
                                <td>{line.name}</td>
                                <td className="num">
                                  {qty(line.quantity)} {line.unit}
                                </td>
                                <td className="num">× {money(line.unitCost)}</td>
                                <td className="num">{money(line.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {count.notes && <p className="muted small">{count.notes}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!data?.counts.length && !loading && (
                <tr>
                  <td colSpan={branches.length > 1 ? 6 : 5} className="empty-orders">
                    No counts yet. Until the first one, purchases count as used when bought.
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

function ItemForm({
  draft,
  setDraft,
  branch,
  busy,
  onSave,
}: {
  draft: ItemDraft;
  setDraft: (d: ItemDraft | null) => void;
  // The branch whose reorder level is set ('' = the default for all).
  branch: string;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <form
      className="admin-panel spending-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2>{draft.id ? `Edit ${draft.name}` : 'Add a stock item'}</h2>
      <div className="spending-fields">
        <label className="setup-field">
          Name
          <input
            value={draft.name}
            maxLength={80}
            autoFocus
            placeholder="e.g. Rice"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="setup-field">
          Unit
          <input
            value={draft.unit}
            maxLength={20}
            placeholder="kg, litre, crate…"
            onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
          />
        </label>
        <label className="setup-field">
          Kind
          <select
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            {Object.entries(PURCHASE_CATEGORY_NAMES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setup-field">
          Cost per unit
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={draft.unitCost}
            onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })}
          />
        </label>
        <label className="setup-field">
          {branch ? `Reorder at, ${branch} (optional)` : 'Reorder at (optional)'}
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={draft.reorderLevel}
            placeholder="Warn when this little is left"
            onChange={(e) => setDraft({ ...draft, reorderLevel: e.target.value })}
          />
        </label>
      </div>
      {draft.id && (
        <label className="setup-checkbox">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />{' '}
          Active (archived items keep their history but are not counted or bought)
        </label>
      )}
      <p className="muted small">
        The cost per unit follows the latest purchase that names the item.
      </p>
      <div className="payment-actions">
        <button disabled={busy || draft.name.trim().length < 2}>
          {draft.id ? 'Save item' : 'Add item'}
        </button>
        <button type="button" className="setup-secondary" onClick={() => setDraft(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CountForm({
  items,
  branchId,
  branch,
  busy,
  onSave,
  onCancel,
}: {
  items: StockItem[];
  // The branch being counted ('' with one branch: the main one).
  branchId: string;
  branch: string;
  busy: boolean;
  onSave: (params: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [day, setDay] = useState(todayIn(timezone));
  const [notes, setNotes] = useState('');
  // Per item: quantity counted ('' = not counted) and cost per unit.
  const [rows, setRows] = useState<Record<string, { quantity: string; unitCost: string }>>(() =>
    Object.fromEntries(
      items.map((i) => [i.id, { quantity: '', unitCost: String(i.unitCost || '') }]),
    ),
  );
  const counted = useMemo(
    () =>
      items
        .filter((i) => rows[i.id]?.quantity !== '' && rows[i.id]?.quantity !== undefined)
        .map((i) => ({
          itemId: i.id,
          quantity: Number(rows[i.id].quantity) || 0,
          unitCost: Number(rows[i.id].unitCost) || 0,
        })),
    [items, rows],
  );
  const total = counted.reduce((n, l) => n + Math.round(l.quantity * l.unitCost), 0);
  const set = (id: string, patch: Partial<{ quantity: string; unitCost: string }>) =>
    setRows((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
  return (
    <form
      className="admin-panel spending-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ day, ...(branchId && { branchId }), lines: counted, notes });
      }}
    >
      <h2>{branch ? `Count stock: ${branch}` : 'Count stock'}</h2>
      <p className="muted small">
        What is on the shelves at the end of the day, at cost. Leave an item empty if it was not
        counted; enter 0 if there is none.
      </p>
      <div className="spending-fields">
        <label className="setup-field">
          Day (end of)
          <input
            type="date"
            value={day}
            max={todayIn(timezone)}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
      </div>
      <div className="table-scroll">
        <table className="data count-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Counted</th>
              <th className="num">Cost per unit</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const row = rows[item.id] ?? { quantity: '', unitCost: '' };
              const value =
                row.quantity === ''
                  ? null
                  : Math.round((Number(row.quantity) || 0) * (Number(row.unitCost) || 0));
              return (
                <tr key={item.id}>
                  <td>
                    {item.name}
                    {item.unit && <small className="block muted">{item.unit}</small>}
                  </td>
                  <td className="num">
                    <input
                      aria-label={`${item.name} counted`}
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(e) => set(item.id, { quantity: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`${item.name} cost per unit`}
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={row.unitCost}
                      onChange={(e) => set(item.id, { unitCost: e.target.value })}
                    />
                  </td>
                  <td className="num">{value === null ? '—' : money(value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="purchase-total">
        {counted.length} of {items.length} counted · Total <strong>{money(total)}</strong>
      </p>
      <label className="setup-field">
        Notes (optional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </label>
      <div className="payment-actions">
        <button disabled={busy || !counted.length}>Save count</button>
        <button type="button" className="setup-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
