import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { providerLabel } from './MobileMoney';
import { statusLabel, statusTone } from '../lib/labels';
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
  orderType?: string;
  source?: string;
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
  // Rows come 2,000 per page, newest first; the summary covers every match.
  page: number;
  pages: number;
  pageSize: number;
  totalRows: number;
};

const STATUSES = [
  ['', 'Any status'],
  ['open', 'In progress'],
  ['PICKED_UP', 'Out for delivery'],
  ['DELIVERED', 'Delivered'],
  ['CANCELLED', 'Cancelled'],
] as const;

const CHANNELS = [
  ['', 'Any channel'],
  ['phone', 'Phone call'],
  ['whatsapp', 'WhatsApp'],
  ['walkin', 'Walk-in'],
  ['other', 'Other'],
] as const;

const CASH_STATES = [
  ['', 'Any cash status'],
  ['WITH_RIDER', 'With rider'],
  ['HANDOVER_PENDING', 'Handover pending'],
  ['RECONCILED', 'Reconciled'],
  ['IN_TILL', 'In the till (counter)'],
  ['UNPAID', 'Not paid yet'],
  ['NOT_COLLECTED', 'Not collected yet'],
  ['REFUNDED', 'Refunded'],
] as const;

export function AdminOrders() {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const [filters, setFilters] = useFilters('last7');
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [cashStatus, setCashStatus] = useState('');
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const riders = useRiderOptions();
  // Any filter change starts again from the newest page.
  const filterKey = JSON.stringify([filters, status, channel, cashStatus]);
  useEffect(() => setPage(0), [filterKey]);
  const { data, error, loading } = useCloud<Result>(
    'adminSearchOrders',
    filterParams(filters, {
      ...(status && { status }),
      ...(channel && { channel }),
      ...(cashStatus && { cashStatus }),
      ...(page && { page }),
    }),
  );
  const rows = (data?.rows ?? []).filter((o) =>
    `${o.code} ${o.customer} ${o.rider} ${o.status} ${o.reference}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const when = (at: string | null) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const payment = (o: OrderRow) =>
    o.method === 'mobile_money' || o.method === 'card'
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
        <label>
          <span>Channel</span>
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Cash status</span>
          <select
            aria-label="Cash status"
            value={cashStatus}
            onChange={(e) => setCashStatus(e.target.value)}
          >
            {CASH_STATES.map(([value, label]) => (
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
          <Stat
            label="Rider pay"
            value={money(s.commission)}
            note="Commission + delivery fees, delivered orders"
          />
        </div>
      )}
      <section className="admin-panel recent-table admin-section-panel">
        <div className="panel-title">
          <div>
            <h2>
              Orders{' '}
              <small>
                ({rows.length}
                {data && data.totalRows > rows.length
                  ? ` of ${data.totalRows.toLocaleString()}`
                  : ''}
                )
              </small>
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
        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Created</th>
                  <th>Rider</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr
                    key={o.id}
                    className="clickable"
                    tabIndex={0}
                    title="Open the order"
                    onClick={() => navigate(`/admin/orders/${o.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/orders/${o.id}`)}
                  >
                    <td>
                      <span className="code">{o.code}</span>
                      <small>{o.customer}</small>
                    </td>
                    <td className="nowrap">{when(o.createdAt)}</td>
                    <td>
                      {o.rider ||
                        (o.orderType === 'eat_in'
                          ? 'Eat in'
                          : o.orderType === 'pickup'
                            ? 'Pick up'
                            : 'No rider yet')}
                      {o.source === 'counter' && <small>Taken at the counter</small>}
                    </td>
                    <td>{payment(o)}</td>
                    <td>
                      <span className={`status-pill ${statusTone(o.status)}`}>
                        {statusLabel(o.status)}
                      </span>
                    </td>
                    <td className="num">{money(o.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>{rows.length} orders</td>
                  <td className="num">{money(rows.reduce((n, o) => n + o.total, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {data && !rows.length && <p className="empty-orders">No matching orders.</p>}
        {data && data.pages > 1 && (
          <div className="pager">
            <button
              className="setup-secondary"
              disabled={loading || data.page === 0}
              onClick={() => setPage(data.page - 1)}
            >
              Newer
            </button>
            <span>
              Page {data.page + 1} of {data.pages} · orders{' '}
              {(data.page * data.pageSize + 1).toLocaleString()}–
              {Math.min((data.page + 1) * data.pageSize, data.totalRows).toLocaleString()} of{' '}
              {data.totalRows.toLocaleString()}
            </span>
            <button
              className="setup-secondary"
              disabled={loading || data.page + 1 >= data.pages}
              onClick={() => setPage(data.page + 1)}
            >
              Older
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
