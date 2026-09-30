import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Data, Layout } from 'plotly.js';
import { ChevronRight } from 'lucide-react';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { statusLabel, statusTone } from '../lib/labels';
import { useCloud } from './reports/common';
import { Chart, SERIES } from './reports/Chart';
import { useLiveRefresh } from '../lib/live';

type Dashboard = {
  day: string;
  today: {
    orders: number;
    open: number;
    cancelled: number;
    delivered: number;
    sales: number;
    riderPay: number;
    kept: number;
    avgOrder: number;
    avgDeliveryMinutes: number | null;
    avgCounterMinutes: number | null;
    cashReceived: number;
    riderCash: number;
    counterCash: number;
    byType: { key: string; orders: number; amount: number }[];
    counterSales: number;
  };
  topRider: { rider: string; delivered: number; sales: number } | null;
  cash: { total: number; withRiders: number; handedOver: number; riders: number };
  riderPayOwed: number;
  attention: {
    momoPending: number;
    handoversPending: number;
    handoversDisputed: number;
    openIssues: number;
  };
  onShift: { riders: number; cashiers: number; onBreak: number };
  hours: { hour: number; orders: number; sales: number }[];
  days: { day: string; orders: number; sales: number }[];
  recent: {
    id: string;
    code: string;
    rider: string;
    customer: string;
    status: string;
    total: number;
    method: string;
    createdAt: string;
  }[];
};

const KIND: Record<string, string> = { delivery: 'delivery', eat_in: 'eat in', pickup: 'pick up' };

// Owner: today at a glance, computed on the server (getDashboard).
export function AdminOverview({ version }: { version: number }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const finance = useSession().profile?.role === 'finance';
  const { data, error, loading, reload } = useCloud<Dashboard>('getDashboard', {});
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  useLiveRefresh(['Order', 'CashHandover'], reload, { fastMs: 30000, slowMs: 120000 });

  const charts = useMemo(() => {
    if (!data) return null;
    const hours = data.hours.filter((h) => h.hour >= 6 || h.orders > 0);
    const byHour: Data[] = [
      {
        type: 'bar',
        x: hours.map((h) => `${h.hour}h`),
        y: hours.map((h) => h.orders),
        marker: { color: SERIES[1] },
        customdata: hours.map((h) => money(h.sales)),
        hovertemplate: '<b>%{y} orders</b><br>%{x} · %{customdata} delivered<extra></extra>',
      },
    ];
    const byDay: Data[] = [
      {
        type: 'bar',
        x: data.days.map((d) =>
          formatDate(`${d.day}T12:00:00Z`, 'UTC', { day: 'numeric', month: 'short' }),
        ),
        y: data.days.map((d) => d.sales),
        marker: { color: SERIES[0] },
        customdata: data.days.map((d) => [money(d.sales), d.orders]),
        hovertemplate: '<b>%{customdata[0]}</b><br>%{x} · %{customdata[1]} orders<extra></extra>',
      },
    ];
    return { byHour, byDay, hourCount: hours.length };
  }, [data, money]);

  // Category axes: every 3rd hour and every 5th day, kept horizontal.
  const countAxis: Partial<Layout> = useMemo(
    () => ({ yaxis: { tickformat: 'd', rangemode: 'tozero' }, xaxis: { tickangle: 0, dtick: 3 } }),
    [],
  );
  const dayAxis: Partial<Layout> = useMemo(() => ({ xaxis: { tickangle: 0, dtick: 5 } }), []);

  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return <p className="muted">{loading ? 'Loading today…' : ''}</p>;

  const t = data.today;
  const a = data.attention;
  const attention = [
    a.momoPending && {
      label: `${a.momoPending} mobile money ${a.momoPending === 1 ? 'payment' : 'payments'} to check`,
      to: '/admin/payments',
    },
    a.handoversPending && {
      label: `${a.handoversPending} cash ${a.handoversPending === 1 ? 'handover' : 'handovers'} waiting for a count`,
      to: '/admin/payments',
    },
    a.handoversDisputed && {
      label: `${a.handoversDisputed} disputed ${a.handoversDisputed === 1 ? 'handover' : 'handovers'} to resolve`,
      to: '/admin/payments',
      bad: true,
    },
    a.openIssues &&
      !finance && {
        label: `${a.openIssues} open ${a.openIssues === 1 ? 'problem' : 'problems'}`,
        to: '/admin/problems',
        bad: true,
      },
  ].filter(Boolean) as { label: string; to: string; bad?: boolean }[];

  return (
    <div className={loading ? 'overview busy' : 'overview'}>
      <div className="admin-metrics">
        <article>
          <span>Net revenue today</span>
          <strong>{money(t.kept)}</strong>
          <small>
            Sales {money(t.sales)} · less {money(t.riderPay)} rider pay
          </small>
        </article>
        <article>
          <span>Orders today</span>
          <strong>{t.orders}</strong>
          <small>
            {t.delivered} delivered · {t.open} in progress
            {t.cancelled ? ` · ${t.cancelled} cancelled` : ''}
            {t.byType.some((k) => k.key !== 'delivery' && k.orders) &&
              ` · ${t.byType
                .filter((k) => k.orders)
                .map((k) => `${k.orders} ${KIND[k.key] || k.key}`)
                .join(', ')}`}
          </small>
        </article>
        <article>
          <span>Cash with riders</span>
          <strong>{money(data.cash.total)}</strong>
          <small>
            {data.cash.riders} {data.cash.riders === 1 ? 'rider' : 'riders'}
            {data.cash.handedOver ? ` · ${money(data.cash.handedOver)} waiting for a count` : ''}
          </small>
        </article>
        <article>
          <span>Cash counted in today</span>
          <strong>{money(t.cashReceived)}</strong>
          <small>
            {money(t.riderCash)} from rider handovers
            {t.counterCash ? ` · ${money(t.counterCash)} at the counter` : ''}
          </small>
        </article>
        <article>
          <span>Rider pay owed</span>
          <strong>{money(data.riderPayOwed)}</strong>
          <small>Commission + delivery fees not yet paid</small>
        </article>
        <article>
          <span>Top rider today</span>
          <strong>{data.topRider ? data.topRider.rider.split(' · ').pop() : '—'}</strong>
          <small>
            {data.topRider
              ? `${data.topRider.delivered} delivered · ${money(data.topRider.sales)}`
              : 'No deliveries yet'}
          </small>
        </article>
        <article>
          <span>Average order</span>
          <strong>{money(t.avgOrder)}</strong>
          <small>
            {[
              t.avgDeliveryMinutes !== null && `${t.avgDeliveryMinutes} min order to door`,
              t.avgCounterMinutes !== null && `${t.avgCounterMinutes} min to serve at the counter`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Delivered orders today'}
          </small>
        </article>
        <article>
          <span>On shift now</span>
          <strong>
            {data.onShift.riders} {data.onShift.riders === 1 ? 'rider' : 'riders'}
          </strong>
          <small>
            {data.onShift.cashiers} {data.onShift.cashiers === 1 ? 'cashier' : 'cashiers'}
            {data.onShift.onBreak ? ` · ${data.onShift.onBreak} on a break` : ''}
          </small>
        </article>
      </div>

      {attention.length > 0 && (
        <section className="admin-panel attention-panel">
          <h2>Needs attention</h2>
          <ul>
            {attention.map((item) => (
              <li key={item.label} className={item.bad ? 'bad' : ''}>
                <button className="link-button" onClick={() => navigate(item.to)}>
                  {item.label} <ChevronRight />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {charts && (
        <div className="overview-charts">
          <section className="admin-panel">
            <div className="panel-title">
              <h2>Orders by hour today</h2>
            </div>
            <Chart
              data={charts.byHour}
              layout={countAxis}
              bars={charts.hourCount}
              height={220}
              label="Orders placed per hour today"
            />
          </section>
          <section className="admin-panel">
            <div className="panel-title">
              <h2>Sales, last 30 days</h2>
              <button className="link-button" onClick={() => navigate('/admin/reports')}>
                Reports
              </button>
            </div>
            <Chart
              data={charts.byDay}
              layout={dayAxis}
              bars={30}
              height={220}
              label="Delivered sales per day"
            />
          </section>
        </div>
      )}

      <section className="admin-panel recent-table">
        <div className="panel-title">
          <h2>Recent orders</h2>
          <button className="link-button" onClick={() => navigate('/admin/orders')}>
            View all orders
          </button>
        </div>
        {data.recent.length ? (
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Placed</th>
                  <th>Rider</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((o) => (
                  <tr
                    key={o.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => navigate(`/admin/orders/${o.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/orders/${o.id}`)}
                  >
                    <td data-label="Order">
                      <span className="code">{o.code}</span>
                      <small>{o.customer}</small>
                    </td>
                    <td data-label="Placed" className="nowrap">
                      {formatDate(o.createdAt, timezone, { timeStyle: 'short' })}
                    </td>
                    <td data-label="Rider">{o.rider}</td>
                    <td data-label="Status">
                      <span className={`status-pill ${statusTone(o.status)}`}>
                        {statusLabel(o.status)}
                      </span>
                    </td>
                    <td data-label="Total" className="num">
                      {money(o.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-orders">No orders yet. New tickets will appear here.</p>
        )}
      </section>
    </div>
  );
}
