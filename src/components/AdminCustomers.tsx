import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { statusLabel, statusTone } from '../lib/labels';
import { useCloud } from './reports/common';

// Owner and finance: the restaurant's customers (made from orders), with
// their order history, and corrections to their details.

type Customer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  addresses: { text: string; notes: string }[];
  orderCount: number;
  lastOrderAt: string | null;
  createdAt: string;
};
type Detail = Customer & {
  spent: number;
  orders: { id: string; code: string; status: string; total: number; at: string; type: string }[];
};

const SORTS = [
  ['orders', 'Most orders'],
  ['recent', 'Ordered recently'],
  ['name', 'Name'],
] as const;

export function AdminCustomers() {
  const { timezone } = useConfig();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>('orders');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useCloud<{
    customers: Customer[];
    more: boolean;
    total: number;
  }>('listCustomers', { q: search, sort, page });
  const date = (value: string | null) =>
    value ? formatDate(value, timezone, { dateStyle: 'medium' }) : '—';

  return (
    <div className={loading ? 'report busy' : 'report'}>
      <div className="filter-bar" role="search">
        <form
          className="search customer-search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(0);
            setSearch(q.trim());
          }}
        >
          <Search />
          <input
            aria-label="Find a customer"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or phone"
          />
        </form>
        <label>
          <span>Sort</span>
          <select
            value={sort}
            onChange={(e) => {
              setPage(0);
              setSort(e.target.value as typeof sort);
            }}
          >
            {SORTS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {data && <p className="filter-range">{data.total} customers in all</p>}
      </div>
      {error && <p className="ops-error">{error}</p>}
      <section className="admin-panel admin-section-panel">
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th className="num">Orders</th>
                <th>Last order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.customers ?? []).map((c) => (
                <CustomerRow
                  key={c.id}
                  customer={c}
                  open={open === c.id}
                  onToggle={() => setOpen(open === c.id ? null : c.id)}
                  onSaved={reload}
                  date={date}
                />
              ))}
              {!data?.customers.length && !loading && (
                <tr>
                  <td colSpan={5} className="empty-orders">
                    {search ? 'No customer matches.' : 'No customers yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(page > 0 || data?.more) && (
          <div className="payment-actions">
            <button
              className="setup-secondary"
              disabled={page === 0}
              onClick={() => setPage((n) => n - 1)}
            >
              Previous
            </button>
            <button
              className="setup-secondary"
              disabled={!data?.more}
              onClick={() => setPage((n) => n + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function CustomerRow({
  customer: c,
  open,
  onToggle,
  onSaved,
  date,
}: {
  customer: Customer;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
  date: (value: string | null) => string;
}) {
  return (
    <>
      <tr>
        <td data-label="Customer">
          <b>{c.name}</b>
          {c.addresses[0]?.text && <small>{c.addresses[0].text}</small>}
        </td>
        <td data-label="Phone">{c.phone || '—'}</td>
        <td data-label="Orders" className="num">
          {c.orderCount}
        </td>
        <td data-label="Last order">{date(c.lastOrderAt)}</td>
        <td className="actions-cell">
          <button className="link-button" onClick={onToggle}>
            {open ? 'Close' : 'Open'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={5}>
            <CustomerDetail id={c.id} onSaved={onSaved} date={date} />
          </td>
        </tr>
      )}
    </>
  );
}

function CustomerDetail({
  id,
  onSaved,
  date,
}: {
  id: string;
  onSaved: () => void;
  date: (value: string | null) => string;
}) {
  const money = useMoney();
  const navigate = useNavigate();
  const { data, error, reload } = useCloud<Detail>('getCustomer', { id });
  const [draft, setDraft] = useState<{
    name: string;
    phone: string;
    email: string;
    notes: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const form = draft ?? {
    name: data.name,
    phone: data.phone,
    email: data.email,
    notes: data.notes,
  };
  const edit = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setDraft({ ...form, [key]: e.target.value });
  return (
    <div className="spending-detail">
      <form
        className="customer-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setSaveError('');
          try {
            await Parse.Cloud.run('saveCustomer', { id, ...form });
            setDraft(null);
            reload();
            onSaved();
          } catch (err) {
            setSaveError(err instanceof Error ? err.message : 'Could not save');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="setup-field">
          Name
          <input value={form.name} onChange={edit('name')} maxLength={80} />
        </label>
        <label className="setup-field">
          Phone
          <input value={form.phone} onChange={edit('phone')} inputMode="tel" maxLength={20} />
        </label>
        <label className="setup-field">
          Email
          <input value={form.email} onChange={edit('email')} type="email" maxLength={120} />
        </label>
        <label className="setup-field">
          Notes (allergies, preferences…)
          <input value={form.notes} onChange={edit('notes')} maxLength={300} />
        </label>
        {saveError && <p className="form-error">{saveError}</p>}
        <div className="payment-actions">
          <button disabled={busy || !draft}>Save details</button>
        </div>
      </form>
      <div>
        <p className="mini-table-title">
          {data.orderCount} orders · {money(data.spent)} spent on delivered orders · customer since{' '}
          {date(data.createdAt)}
        </p>
        {!!data.addresses.length && (
          <p className="muted small">Addresses: {data.addresses.map((a) => a.text).join(' · ')}</p>
        )}
        <div className="mini-table">
          {data.orders.slice(0, 12).map((o) => (
            <div key={o.id}>
              <button className="link-button" onClick={() => navigate(`/admin/orders/${o.id}`)}>
                {o.code}
              </button>
              <span>
                {date(o.at)} ·{' '}
                <span className={`status-pill ${statusTone(o.status)}`}>
                  {statusLabel(o.status)}
                </span>
              </span>
              <strong>{money(o.total)}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
