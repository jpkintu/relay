import { useState } from 'react';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { providerLabel } from './MobileMoney';
import {
  FilterBar,
  Stat,
  downloadCsv,
  filterParams,
  useCloud,
  useFilters,
  useRiderOptions,
} from './reports/common';

type OrderRow = {
  id: string;
  code: string;
  status: string;
  channel: string;
  customer: string;
  riderId: string;
  rider: string;
  total: number;
  subtotal: number;
  deliveryFee: number;
  commission: number;
  method: string;
  provider: string;
  reference: string;
  paymentStatus: string;
  amountCollected: number;
  cashStatus: string;
  createdAt: string;
  deliveredAt: string | null;
};

type Result = {
  summary: {
    orders: number;
    delivered: number;
    cancelled: number;
    open: number;
    revenue: number;
    commission: number;
    avgOrder: number;
  };
  rows: OrderRow[];
  truncated: boolean;
};

const STATUSES = [
  ['', 'Any status'],
  ['open', 'In progress'],
  ['PICKED_UP', 'Out for delivery'],
  ['DELIVERED', 'Delivered'],
  ['CANCELLED', 'Cancelled'],
] as const;

export function AdminOrders() {
  const money = useMoney();
  const { timezone } = useConfig();
  const [filters, setFilters] = useFilters('last7');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const riders = useRiderOptions();
  const { data, error, loading } = useCloud<Result>(
    'adminSearchOrders',
    filterParams(filters, status ? { status } : {}),
  );
  const rows = (data?.rows ?? []).filter((o) =>
    `${o.code} ${o.customer} ${o.rider} ${o.status} ${o.reference}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const when = (at: string | null) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const payment = (o: OrderRow) =>
    o.method === 'mobile_money'
      ? `${providerLabel(o.provider)}${o.reference ? ` · ${o.reference}` : ''}`
      : 'Cash';
  const exportCsv = () =>
    downloadCsv(
      `relay-orders-${filters.from}-to-${filters.to}`,
      [
        'Order code',
        'Created',
        'Delivered',
        'Customer',
        'Rider',
        'Channel',
        'Status',
        'Payment',
        'Payment status',
        'Cash status',
        'Subtotal',
        'Delivery fee',
        'Total',
        'Collected',
        'Commission',
      ],
      rows.map((o) => [
        o.code,
        when(o.createdAt),
        o.deliveredAt ? when(o.deliveredAt) : '',
        o.customer,
        o.rider,
        o.channel,
        o.status,
        payment(o),
        o.paymentStatus,
        o.cashStatus,
        o.subtotal,
        o.deliveryFee,
        o.total,
        o.amountCollected,
        o.commission,
      ]),
    );
  const s = data?.summary;
  return (
    <div className={loading ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters} riders={riders} showMethod>
        <label>
          <span>Status</span>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="filter-action" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {s && (
        <div className="stat-grid">
          <Stat label="Orders" value={s.orders} note={`${s.open} in progress`} />
          <Stat
            label="Delivered sales"
            value={money(s.revenue)}
            note={`${s.delivered} delivered · ${s.cancelled} cancelled`}
          />
          <Stat label="Average order" value={money(s.avgOrder)} note="Delivered orders" />
          <Stat label="Commission" value={money(s.commission)} note="Paid to riders" />
        </div>
      )}
      <section className="admin-panel recent-table admin-section-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Accounting ledger</p>
            <h2>
              Orders <small>({rows.length})</small>
            </h2>
          </div>
        </div>
        <input
          className="admin-filter"
          placeholder="Search code, customer, rider, status or reference"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search orders"
        />
        <div className="admin-table-scroll">
          <div className="table-row table-heading ledger-row">
            <span>Order</span>
            <span>Created</span>
            <span>Rider</span>
            <span>Payment</span>
            <span>Status</span>
            <span>Total</span>
          </div>
          {rows.map((o) => (
            <div className="table-row ledger-row" key={o.id}>
              <span>
                {o.code}
                <small>{o.customer}</small>
              </span>
              <span>{when(o.createdAt)}</span>
              <span>{o.rider}</span>
              <span>{payment(o)}</span>
              <span className="status-pill">{o.status}</span>
              <strong>{money(o.total)}</strong>
            </div>
          ))}
        </div>
        {data && !rows.length && <p className="empty-orders">No matching orders.</p>}
        {data?.truncated && (
          <p className="muted small">Showing the latest 2,000. Narrow the dates to see more.</p>
        )}
      </section>
    </div>
  );
}
