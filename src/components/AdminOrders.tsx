import { useState } from 'react';
import { useMoney } from '../lib/session';
export type AdminOrder = {
  id: string;
  code: string;
  rider: string;
  customer: string;
  status: string;
  total: number;
  amountCollected: number;
  cashStatus: string;
  commission: number;
  createdAt: Date;
};
export function AdminOrders({ orders }: { orders: AdminOrder[] }) {
  const money = useMoney();
  const [query, setQuery] = useState('');
  const rows = orders.filter((o) =>
    `${o.code} ${o.customer} ${o.rider} ${o.status}`.toLowerCase().includes(query.toLowerCase()),
  );
  const exportCsv = () => {
    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const columns = [
      'Order code',
      'Customer',
      'Rider',
      'Status',
      'Cash status',
      'Total',
      'Commission',
      'Created at',
    ];
    const content = [
      columns.join(','),
      ...rows.map((o) =>
        [
          o.code,
          o.customer,
          o.rider,
          o.status,
          o.cashStatus,
          o.total,
          o.commission,
          o.createdAt.toISOString(),
        ]
          .map(escape)
          .join(','),
      ),
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `relay-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="admin-panel recent-table admin-section-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Accounting ledger</p>
          <h2>
            Orders <small>({rows.length})</small>
          </h2>
        </div>
        <button onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </div>
      <input
        className="admin-filter"
        placeholder="Search code, customer, rider or status"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search orders"
      />
      <div className="admin-table-scroll">
        <div className="table-row table-heading">
          <span>Order</span>
          <span>Rider</span>
          <span>Customer</span>
          <span>Status</span>
          <span>Total</span>
        </div>
        {rows.map((o) => (
          <div className="table-row" key={o.id}>
            <span>{o.code}</span>
            <span>{o.rider}</span>
            <span>{o.customer}</span>
            <span className="status-pill">{o.status}</span>
            <span>{money(o.total)}</span>
          </div>
        ))}
      </div>
      {!rows.length && <p className="empty-orders">No matching orders.</p>}
    </section>
  );
}
