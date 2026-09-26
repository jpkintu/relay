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

type Ledger = {
  total: number;
  deliveries: number;
  riders: {
    riderId: string;
    rider: string;
    deliveries: number;
    sales: number;
    commission: number;
  }[];
  rows: {
    id: string;
    code: string;
    rider: string;
    customer: string;
    total: number;
    subtotal: number;
    commission: number;
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
  const { data, error, loading } = useCloud<Ledger>('getCommissionLedger', filterParams(filters));
  const when = (at: string) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const rows = data?.rows ?? [];
  const exportCsv = () =>
    downloadCsv(
      `relay-commissions-${filters.from}-to-${filters.to}`,
      ['Delivered', 'Order', 'Rider', 'Customer', 'Subtotal', 'Total', 'Commission'],
      rows.map((r) => [
        when(r.deliveredAt),
        r.code,
        r.rider,
        r.customer,
        r.subtotal,
        r.total,
        r.commission,
      ]),
    );
  return (
    <div className={loading ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters} riders={riders}>
        <button className="filter-action" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && (
        <div className="stat-grid">
          <Stat label="Commission earned" value={money(data.total)} note="By delivery date" />
          <Stat label="Deliveries" value={data.deliveries} />
          <Stat
            label="Average per delivery"
            value={money(data.deliveries ? data.total / data.deliveries : 0)}
          />
        </div>
      )}
      {data && data.riders.length > 0 && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>By rider</h2>
          </div>
          <div className="admin-table-scroll">
            <div className="table-row table-heading summary-row">
              <span>Rider</span>
              <span>Deliveries</span>
              <span>Sales</span>
              <span>Commission</span>
            </div>
            {data.riders.map((r) => (
              <div className="table-row summary-row" key={r.riderId}>
                <span>{r.rider}</span>
                <span>{r.deliveries} deliveries</span>
                <span>{money(r.sales)}</span>
                <strong>{money(r.commission)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Commission ledger <small>({rows.length})</small>
          </h2>
        </div>
        <div className="admin-table-scroll">
          <div className="table-row table-heading">
            <span>Order</span>
            <span>Delivered</span>
            <span>Rider</span>
            <span>Order total</span>
            <span>Commission</span>
          </div>
          {rows.map((r) => (
            <div className="table-row" key={r.id}>
              <span>
                {r.code}
                <small>{r.customer}</small>
              </span>
              <span>{when(r.deliveredAt)}</span>
              <span>{r.rider}</span>
              <span>{money(r.total)}</span>
              <strong>{money(r.commission)}</strong>
            </div>
          ))}
        </div>
        {data && !rows.length && <p className="empty-orders">No deliveries in these dates.</p>}
      </section>
    </div>
  );
}
