import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfig, useMoney } from '../../lib/session';
import { formatDate } from '../../lib/format';
import {
  FilterBar,
  Stat,
  downloadCsv,
  filterParams,
  useCloud,
  useFilters,
  useRiderOptions,
} from './common';

type PayState = 'paid' | 'part' | 'owed';
type Ledger = {
  total: number;
  owed: number;
  paidOut: number;
  deliveries: number;
  riders: {
    riderId: string;
    rider: string;
    deliveries: number;
    sales: number;
    commission: number;
    owed: number;
  }[];
  rows: {
    id: string;
    code: string;
    rider: string;
    customer: string;
    total: number;
    subtotal: number;
    commission: number;
    owed: number;
    payState: PayState;
    method: string;
    deliveredAt: string;
  }[];
  truncated: boolean;
};

export function Commissions() {
  const money = useMoney();
  const { timezone } = useConfig();
  const [filters, setFilters] = useFilters('thisWeek');
  const riders = useRiderOptions();
  const [paid, setPaid] = useState<'all' | 'owed' | 'paid'>('all');
  const navigate = useNavigate();
  const { data, error, loading } = useCloud<Ledger>(
    'getCommissionLedger',
    filterParams(filters, paid === 'all' ? {} : { paid }),
  );
  const when = (at: string) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const rows = data?.rows ?? [];
  const exportCsv = () =>
    downloadCsv(
      `relay-commissions-${filters.from}-to-${filters.to}`,
      ['Delivered', 'Order', 'Rider', 'Customer', 'Subtotal', 'Total', 'Rider pay', 'Still owed'],
      rows.map((r) => [
        when(r.deliveredAt),
        r.code,
        r.rider,
        r.customer,
        r.subtotal,
        r.total,
        r.commission,
        r.owed,
      ]),
    );
  return (
    <div className={loading ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters} riders={riders}>
        <div className="filter-toggle" role="group" aria-label="Paid or owed">
          {(
            [
              ['all', 'All'],
              ['owed', 'Owed'],
              ['paid', 'Paid'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={paid === value ? 'active' : ''}
              aria-pressed={paid === value}
              onClick={() => setPaid(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="filter-action" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && (
        <div className="stat-grid">
          <Stat
            label="Rider pay earned"
            value={money(data.total)}
            note="Commission + delivery fees, by delivery date"
          />
          <Stat
            label="Paid out"
            value={money(data.paidOut)}
            note="From tills, including delivery fees paid at handovers"
          />
          <Stat
            label="Still owed"
            value={money(data.owed)}
            note={data.owed ? 'Pay riders from the cashier Payouts page' : 'Everyone is paid'}
          />
          <Stat
            label="Deliveries"
            value={data.deliveries}
            note={`${money(data.deliveries ? data.total / data.deliveries : 0)} rider pay on average`}
          />
        </div>
      )}
      {data && data.riders.length > 0 && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>By rider</h2>
          </div>
          <div className="table-scroll">
            <table className="data compact-table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th className="num">Deliveries</th>
                  <th className="num">Sales</th>
                  <th className="num">Rider pay</th>
                  <th className="num">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {data.riders.map((r) => (
                  <tr key={r.riderId}>
                    <td>{r.rider}</td>
                    <td className="num">{r.deliveries}</td>
                    <td className="num">{money(r.sales)}</td>
                    <td className="num strong">{money(r.commission)}</td>
                    <td className={`num ${r.owed ? 'strong' : 'muted'}`}>
                      {r.owed ? money(r.owed) : 'Paid'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{data.deliveries}</td>
                  <td className="num">{money(data.riders.reduce((n, r) => n + r.sales, 0))}</td>
                  <td className="num">{money(data.total)}</td>
                  <td className="num">{money(data.owed)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Commission ledger <small>({rows.length})</small>
          </h2>
        </div>
        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Delivered</th>
                  <th>Rider</th>
                  <th className="num">Order total</th>
                  <th className="num">Rider pay</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => navigate(`/admin/orders/${r.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/orders/${r.id}`)}
                  >
                    <td>
                      <span className="code">{r.code}</span>
                      <small>{r.customer}</small>
                    </td>
                    <td className="nowrap">{when(r.deliveredAt)}</td>
                    <td>{r.rider}</td>
                    <td className="num">{money(r.total)}</td>
                    <td className="num strong">{money(r.commission)}</td>
                    <td>
                      <span
                        className={`status-pill ${r.payState === 'paid' ? 'good' : r.payState === 'owed' ? '' : 'part'}`}
                      >
                        {r.payState === 'paid'
                          ? 'Paid'
                          : r.payState === 'owed'
                            ? 'Owed'
                            : `${money(r.owed)} owed`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && !rows.length && (
          <p className="empty-orders">
            {paid === 'all' ? 'No deliveries in these dates.' : `Nothing ${paid} in these dates.`}
          </p>
        )}
      </section>
    </div>
  );
}
