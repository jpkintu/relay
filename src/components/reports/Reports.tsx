import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useConfig, useMoney } from '../../lib/session';
import { bucketLabel, compactNumber, formatChange, rangeLabel, truncate } from '../../lib/range';
import { useDevice } from '../../lib/device';
import type { Period } from '../../lib/range';
import { Chart, DOWN, SERIES, UP } from './Chart';
import {
  FilterBar,
  Stat,
  downloadCsv,
  filterParams,
  useCloud,
  useFilters,
  useRiderOptions,
} from './common';

type Summary = {
  orders: number;
  delivered: number;
  cancelled: number;
  rejected: number;
  open: number;
  revenue: number;
  foodSales: number;
  deliveryFees: number;
  commission: number;
  net: number;
  avgOrder: number;
  cashSales: number;
  mobileMoneySales: number;
  unconfirmedSales: number;
  riderCommission: number;
  customers: number;
  repeatCustomers: number;
  avgDeliveryMinutes: number | null;
};
type SeriesRow = {
  key: string;
  orders: number;
  delivered: number;
  revenue: number;
  commission: number;
  avgOrder: number;
  revenueChange: number | null;
};
type Report = {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  period: Period;
  summary: Summary;
  previous: Summary;
  change: Record<string, number | null>;
  series: SeriesRow[];
  monthly: SeriesRow[];
  items: {
    name: string;
    qty: number;
    revenue: number;
    orders: number;
    share: number;
    avgPrice: number;
  }[];
  accompaniments: { name: string; servings: number }[];
  riders: {
    riderId: string;
    rider: string;
    orders: number;
    delivered: number;
    cancelled: number;
    revenue: number;
    commission: number;
    avgDeliveryMinutes: number | null;
  }[];
  payments: { key: string; orders: number; amount: number }[];
  channels: { key: string; orders: number; amount: number }[];
  hours: { hour: number; orders: number; revenue: number }[];
  weekdays: { weekday: number; orders: number; revenue: number }[];
};

const PAYMENT_NAMES: Record<string, string> = {
  cash: 'Cash',
  airtel: 'Airtel Money',
  mtn: 'MTN MoMo',
  mobile_money: 'Mobile money',
};
// Payment types keep their color whatever the filter (color follows the entity).
const PAYMENT_COLORS: Record<string, string> = {
  cash: SERIES[0],
  airtel: SERIES[1],
  mtn: SERIES[2],
  mobile_money: SERIES[3],
};
const CHANNEL_NAMES: Record<string, string> = {
  walkin: 'Walk-in',
  phone: 'Phone call',
  whatsapp: 'WhatsApp',
  other: 'Other',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export function Reports() {
  const money = useMoney();
  const { currencySymbol } = useConfig();
  const [filters, setFilters] = useFilters('last6months');
  const [period, setPeriod] = useState<'' | Period>('');
  const [itemMeasure, setItemMeasure] = useState<'revenue' | 'qty'>('revenue');
  const riders = useRiderOptions();
  const narrow = useDevice() === 'phone';
  const { data, error, loading } = useCloud<Report>(
    'getOperationsReport',
    filterParams(filters, period ? { period } : {}),
  );

  const charts = useMemo(() => {
    if (!data) return null;
    // Bar-end labels: full money on wide screens, 1.2M on phones.
    const tip = (value: number) => (narrow ? compactNumber(value) : money(value));
    const name = (text: string) => (narrow ? truncate(text, 15) : text);
    const labels = data.series.map((row) =>
      bucketLabel(row.key, data.period, narrow || data.period === 'week'),
    );
    const hover = (value: string, label: string) => `<b>${value}</b><br>${label}<extra></extra>`;
    const revenue: Data[] = [
      {
        type: 'bar',
        x: labels,
        y: data.series.map((row) => row.revenue),
        marker: { color: SERIES[0] },
        customdata: data.series.map((row) => [money(row.revenue), `${row.delivered} delivered`]),
        hovertemplate: hover('%{customdata[0]}', '%{x} · %{customdata[1]}'),
      },
    ];
    const orders: Data[] = [
      {
        type: 'scatter',
        mode: 'lines+markers',
        x: labels,
        y: data.series.map((row) => row.orders),
        line: { color: SERIES[0], width: 2, shape: 'linear' },
        marker: { color: SERIES[0], size: 8, line: { color: '#ffffff', width: 2 } },
        customdata: data.series.map((row) => [`${row.orders} orders`, money(row.avgOrder)]),
        hovertemplate: hover('%{customdata[0]}', '%{x} · avg %{customdata[1]}'),
      },
    ];
    const months = data.monthly.slice(1);
    const growth: Data[] = [
      {
        type: 'bar',
        x: months.map((row) => bucketLabel(row.key, 'month', narrow)),
        y: months.map((row) => row.revenueChange ?? 0),
        marker: { color: months.map((row) => ((row.revenueChange ?? 0) < 0 ? DOWN : UP)) },
        text: months.map((row) => formatChange(row.revenueChange) || 'n/a'),
        textposition: 'outside',
        constraintext: 'none',
        cliponaxis: false,
        textfont: { color: '#0b1633', size: 12 },
        customdata: months.map((row) => [
          formatChange(row.revenueChange) || 'No sales the month before',
          money(row.revenue),
        ]),
        hovertemplate: hover('%{customdata[0]}', '%{x} · %{customdata[1]}'),
      },
    ];
    const topItems = [...data.items].sort((a, b) => b[itemMeasure] - a[itemMeasure]).slice(0, 10);
    const items: Data[] = [
      {
        type: 'bar',
        orientation: 'h',
        y: topItems.map((item) => name(item.name)),
        x: topItems.map((item) => item[itemMeasure]),
        marker: { color: SERIES[0] },
        text: topItems.map((item) =>
          itemMeasure === 'revenue' ? tip(item.revenue) : `${item.qty} sold`,
        ),
        textposition: 'outside',
        cliponaxis: false,
        textfont: { color: '#0b1633' },
        customdata: topItems.map((item) => [
          money(item.revenue),
          `${item.name} · ${item.qty} sold · ${item.share}% of food sales`,
        ]),
        hovertemplate: hover('%{customdata[0]}', '%{customdata[1]}'),
      },
    ];
    const topSides = data.accompaniments.slice(0, 10);
    const sides: Data[] = [
      {
        type: 'bar',
        orientation: 'h',
        y: topSides.map((a) => name(a.name)),
        x: topSides.map((a) => a.servings),
        marker: { color: SERIES[0] },
        text: topSides.map((a) => String(a.servings)),
        textposition: 'outside',
        cliponaxis: false,
        textfont: { color: '#0b1633' },
        customdata: topSides.map((a) => [a.name]),
        hovertemplate: hover('%{x} servings', '%{customdata[0]}'),
      },
    ];
    const payments: Data[] = [
      {
        type: 'bar',
        orientation: 'h',
        y: data.payments.map((p) => PAYMENT_NAMES[p.key] || p.key),
        x: data.payments.map((p) => p.amount),
        marker: { color: data.payments.map((p) => PAYMENT_COLORS[p.key] || SERIES[4]) },
        text: data.payments.map((p) => tip(p.amount)),
        textposition: 'outside',
        cliponaxis: false,
        textfont: { color: '#0b1633' },
        customdata: data.payments.map((p) => [
          money(p.amount),
          `${p.orders} orders · ${pct(p.amount, data.summary.revenue)}%`,
        ]),
        hovertemplate: hover('%{customdata[0]}', '%{y} · %{customdata[1]}'),
      },
    ];
    const hours = data.hours.filter((h, i, all) => {
      // Trim quiet hours at both ends of the day.
      const first = all.findIndex((x) => x.orders > 0);
      const last = all.length - 1 - [...all].reverse().findIndex((x) => x.orders > 0);
      return first >= 0 && i >= first && i <= last;
    });
    const busyHours: Data[] = [
      {
        type: 'bar',
        x: hours.map((h) => (narrow ? String(h.hour) : hourLabel(h.hour))),
        y: hours.map((h) => h.orders),
        marker: { color: SERIES[0] },
        customdata: hours.map((h) => [money(h.revenue)]),
        hovertemplate: hover('%{y} orders', '%{x} · %{customdata[0]} delivered'),
      },
    ];
    const busyDays: Data[] = [
      {
        type: 'bar',
        x: data.weekdays.map((d) => WEEKDAYS[d.weekday]),
        y: data.weekdays.map((d) => d.orders),
        marker: { color: SERIES[0] },
        customdata: data.weekdays.map((d) => [money(d.revenue)]),
        hovertemplate: hover('%{y} orders', '%{x} · %{customdata[0]} delivered'),
      },
    ];
    return {
      revenue,
      orders,
      growth,
      months,
      items,
      topItems,
      sides,
      topSides,
      payments,
      busyHours,
      hours,
      busyDays,
    };
  }, [data, money, itemMeasure, narrow]);

  const moneyAxis: Partial<Layout> = useMemo(
    () => ({
      xaxis: { tickangle: 0, nticks: narrow ? 5 : 14 },
      yaxis: { title: { text: currencySymbol, standoff: 4 } },
    }),
    [currencySymbol, narrow],
  );
  const horizontal: Partial<Layout> = useMemo(
    () => ({
      xaxis: { showgrid: false, showticklabels: false, rangemode: 'tozero' },
      yaxis: { autorange: 'reversed', gridcolor: 'rgba(0,0,0,0)', tickformat: '' },
      margin: { l: 8, r: narrow ? 52 : 120, t: 4, b: 4 },
    }),
    [narrow],
  );
  const growthLayout: Partial<Layout> = useMemo(
    () => ({
      yaxis: {
        ticksuffix: '%',
        tickformat: '',
        zeroline: true,
        zerolinecolor: '#b9bfcc',
        rangemode: 'normal',
      },
      margin: { l: 8, r: 12, t: 24, b: 8 },
    }),
    [],
  );
  const countAxis: Partial<Layout> = useMemo(
    () => ({ xaxis: { tickangle: 0, nticks: narrow ? 6 : 14 }, yaxis: { tickformat: ',d' } }),
    [narrow],
  );

  const s = data?.summary;
  const exportItems = () =>
    data &&
    downloadCsv(
      `relay-menu-sales-${filters.from}-to-${filters.to}`,
      ['Item', 'Quantity', 'Revenue', 'Orders', 'Share of food sales %', 'Average price'],
      data.items.map((i) => [i.name, i.qty, i.revenue, i.orders, i.share, i.avgPrice]),
    );

  return (
    <div className={loading ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters} riders={riders}>
        <label>
          <span>Group by</span>
          <select
            aria-label="Group by"
            value={period}
            onChange={(e) => setPeriod(e.target.value as '' | Period)}
          >
            <option value="">Automatic</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && s && charts && (
        <>
          <div className="report-hero">
            <div>
              <span>Kept by the restaurant · {rangeLabel(data.range)}</span>
              <strong>{money(s.net)}</strong>
              <small>
                Customers paid {money(s.revenue)}
                {data.change.revenue !== null
                  ? ` · ${formatChange(data.change.revenue)} vs ${rangeLabel(data.previousRange)} (${money(data.previous.revenue)})`
                  : ` · no sales in ${rangeLabel(data.previousRange)} to compare with`}
              </small>
            </div>
            <dl>
              <div>
                <dt>Food sales</dt>
                <dd>{money(s.foodSales)}</dd>
              </div>
              <div>
                <dt>Rider commission</dt>
                <dd>−{money(s.riderCommission)}</dd>
              </div>
              <div>
                <dt>Delivery fees</dt>
                <dd>
                  {money(s.deliveryFees)}
                  <small>All paid to riders</small>
                </dd>
              </div>
              <div>
                <dt>Kept by the restaurant</dt>
                <dd>{money(s.net)}</dd>
              </div>
            </dl>
          </div>
          <div className="stat-grid six">
            <Stat
              label="Orders"
              value={s.orders}
              change={data.change.orders}
              note={`${s.delivered} delivered · ${s.open} in progress`}
            />
            <Stat label="Average order" value={money(s.avgOrder)} change={data.change.avgOrder} />
            <Stat
              label="Customers"
              value={s.customers}
              change={data.change.customers}
              note={`${s.repeatCustomers} ordered more than once`}
            />
            <Stat
              label="Cancelled"
              value={`${pct(s.cancelled, s.orders)}%`}
              note={`${s.cancelled} orders · ${s.rejected} rejected by kitchen`}
            />
            <Stat
              label="Order to door"
              value={s.avgDeliveryMinutes === null ? '—' : `${s.avgDeliveryMinutes} min`}
              note="Average, placed to delivered"
            />
            <Stat
              label="Cash / mobile money"
              value={`${pct(s.cashSales, s.revenue)}% / ${pct(s.mobileMoneySales, s.revenue)}%`}
              note={`Confirmed: ${money(s.cashSales)} cash · ${money(s.mobileMoneySales)} mobile money${
                s.unconfirmedSales ? ` · ${money(s.unconfirmedSales)} not yet confirmed` : ''
              }`}
            />
          </div>

          <div className="report-grid">
            <ReportPanel title="Revenue" eyebrow={`Delivered sales by ${data.period}`} wide>
              <Chart
                data={charts.revenue}
                layout={moneyAxis}
                bars={data.series.length}
                label={`Revenue by ${data.period}`}
                busy={loading}
              />
            </ReportPanel>
            <ReportPanel title="Orders" eyebrow={`Orders placed by ${data.period}`} wide>
              <Chart
                data={charts.orders}
                layout={countAxis}
                height={220}
                label={`Orders by ${data.period}`}
                busy={loading}
              />
            </ReportPanel>
            <ReportPanel title="Month on month" eyebrow="Revenue growth" wide>
              {charts.months.length > 0 ? (
                <Chart
                  data={charts.growth}
                  layout={growthLayout}
                  bars={charts.months.length}
                  height={220}
                  label="Revenue change from the month before"
                  busy={loading}
                />
              ) : (
                <p className="muted small">
                  Choose dates covering at least two months (e.g. Last 6 months) to compare months.
                </p>
              )}
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Revenue</th>
                      <th className="num">Change</th>
                      <th className="num">Orders</th>
                      <th className="num">Avg order</th>
                      <th className="num">Rider pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.monthly.map((row) => (
                      <tr key={row.key}>
                        <td>{bucketLabel(row.key, 'month')}</td>
                        <td className="num strong">{money(row.revenue)}</td>
                        <td
                          className={`num ${
                            row.revenueChange === null ? '' : row.revenueChange < 0 ? 'down' : 'up'
                          }`}
                        >
                          {formatChange(row.revenueChange) || '—'}
                        </td>
                        <td className="num">{row.orders}</td>
                        <td className="num">{money(row.avgOrder)}</td>
                        <td className="num">{money(row.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ReportPanel>

            <ReportPanel
              title="Menu item sales"
              eyebrow={`Top ${charts.topItems.length} of ${data.items.length} items`}
              wide
              action={
                <div className="filter-toggle small" role="group" aria-label="Rank items by">
                  {(
                    [
                      ['revenue', 'Revenue'],
                      ['qty', 'Quantity'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={itemMeasure === value ? 'active' : ''}
                      aria-pressed={itemMeasure === value}
                      onClick={() => setItemMeasure(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
            >
              {charts.topItems.length > 0 ? (
                <Chart
                  data={charts.items}
                  layout={horizontal}
                  bars={charts.topItems.length}
                  horizontal
                  height={charts.topItems.length * 34 + 16}
                  label="Top menu items"
                  busy={loading}
                />
              ) : (
                <p className="empty-orders">No delivered orders in these dates.</p>
              )}
              <details className="report-table">
                <summary>
                  All items ({data.items.length})
                  <button
                    className="filter-action"
                    onClick={(e) => {
                      e.preventDefault();
                      exportItems();
                    }}
                    disabled={!data.items.length}
                  >
                    Export CSV
                  </button>
                </summary>
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Sold</th>
                        <th className="num">Revenue</th>
                        <th className="num">Share</th>
                        <th className="num">Avg price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.name}>
                          <td>{item.name}</td>
                          <td className="num">{item.qty}</td>
                          <td className="num strong">{money(item.revenue)}</td>
                          <td className="num">{item.share}%</td>
                          <td className="num">{money(item.avgPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </ReportPanel>

            <ReportPanel title="Accompaniments" eyebrow="Free sides served">
              {charts.topSides.length > 0 ? (
                <Chart
                  data={charts.sides}
                  layout={horizontal}
                  bars={charts.topSides.length}
                  horizontal
                  height={charts.topSides.length * 34 + 16}
                  label="Accompaniments served"
                  busy={loading}
                />
              ) : (
                <p className="empty-orders">No accompaniments served in these dates.</p>
              )}
            </ReportPanel>

            <ReportPanel
              title="Payment mix"
              eyebrow="Confirmed money: cash counted in, mobile money verified"
            >
              {data.payments.length > 0 ? (
                <Chart
                  data={charts.payments}
                  layout={horizontal}
                  bars={data.payments.length}
                  horizontal
                  height={data.payments.length * 34 + 16}
                  label="Sales by payment type"
                  busy={loading}
                />
              ) : (
                <p className="empty-orders">No confirmed payments in these dates.</p>
              )}
              {s.unconfirmedSales > 0 && (
                <p className="muted small">
                  {money(s.unconfirmedSales)} not yet confirmed: cash still with riders or waiting
                  for a cashier, and mobile money waiting for a check.
                </p>
              )}
              <p className="mini-table-title">Orders by channel</p>
              <div className="mini-table">
                {data.channels.map((c) => (
                  <div key={c.key}>
                    <span>{CHANNEL_NAMES[c.key] || c.key}</span>
                    <span>{c.orders} orders</span>
                    <strong>{money(c.amount)}</strong>
                  </div>
                ))}
              </div>
            </ReportPanel>

            <ReportPanel title="Busiest hours" eyebrow="Orders placed by hour">
              {charts.hours.length > 0 ? (
                <Chart
                  data={charts.busyHours}
                  layout={countAxis}
                  bars={charts.hours.length}
                  height={220}
                  label="Orders by hour of day"
                  busy={loading}
                />
              ) : (
                <p className="empty-orders">No orders in these dates.</p>
              )}
            </ReportPanel>

            <ReportPanel title="Busiest days" eyebrow="Orders placed by weekday">
              <Chart
                data={charts.busyDays}
                layout={countAxis}
                bars={7}
                height={220}
                label="Orders by day of week"
                busy={loading}
              />
            </ReportPanel>

            <ReportPanel title="Riders" eyebrow="Performance in these dates" wide>
              {data.riders.length > 0 && (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Rider</th>
                        <th className="num">Delivered</th>
                        <th className="num">Sales</th>
                        <th className="num">Rider pay</th>
                        <th className="num">Order to door</th>
                        <th className="num">Cancelled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.riders.map((r) => (
                        <tr key={r.riderId}>
                          <td>{r.rider}</td>
                          <td className="num">
                            {r.delivered} of {r.orders}
                          </td>
                          <td className="num strong">{money(r.revenue)}</td>
                          <td className="num">{money(r.commission)}</td>
                          <td className="num">
                            {r.avgDeliveryMinutes === null ? '—' : `${r.avgDeliveryMinutes} min`}
                          </td>
                          <td className="num">{r.cancelled}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!data.riders.length && <p className="empty-orders">No orders in these dates.</p>}
            </ReportPanel>
          </div>
        </>
      )}
    </div>
  );
}

function ReportPanel({
  title,
  eyebrow,
  wide,
  action,
  children,
}: {
  title: string;
  eyebrow: string;
  wide?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={wide ? 'admin-panel report-panel wide' : 'admin-panel report-panel'}>
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p className="panel-sub">{eyebrow}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
