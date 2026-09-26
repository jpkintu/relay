import { useMemo, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useConfig, useMoney } from '../../lib/session';
import { formatDate } from '../../lib/format';
import {
  bucketLabel,
  compactNumber,
  formatChange,
  presetRange,
  rangeLabel,
  todayIn,
} from '../../lib/range';
import { useDevice } from '../../lib/device';
import type { Preset } from '../../lib/range';
import { Chart, SERIES } from './Chart';
import { FilterBar, Stat, useCloud } from './common';
import type { Filters } from './common';

type Earnings = {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  period: 'week' | 'month';
  summary: {
    deliveries: number;
    earnings: number;
    sales: number;
    cash: number;
    avgPerDelivery: number;
    earningsChange: number | null;
    deliveriesChange: number | null;
  };
  previous: { deliveries: number; earnings: number };
  series: {
    key: string;
    deliveries: number;
    earnings: number;
    sales: number;
    change: number | null;
  }[];
  deliveries: {
    id: string;
    code: string;
    customer: string;
    total: number;
    commission: number;
    method: string;
    deliveredAt: string;
  }[];
};

const VIEWS = {
  week: { preset: 'last8weeks', presets: ['thisWeek', 'lastWeek', 'last8weeks', 'last90'] },
  month: {
    preset: 'last6months',
    presets: ['thisMonth', 'lastMonth', 'last6months', 'last12months', 'thisYear'],
  },
} as const;

// A rider's own earnings: week on week or month on month, with a chart.
export function RiderEarnings({ riderId }: { riderId?: string }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const narrow = useDevice() === 'phone';
  const [view, setView] = useState<'week' | 'month'>('week');
  const [filters, setFilters] = useState<Filters>(() => ({
    preset: VIEWS.week.preset,
    ...presetRange(VIEWS.week.preset, todayIn(timezone)),
    riderId: '',
    method: '',
  }));
  const switchView = (next: 'week' | 'month') => {
    setView(next);
    const preset: Preset = VIEWS[next].preset;
    setFilters({ ...filters, preset, ...presetRange(VIEWS[next].preset, todayIn(timezone)) });
  };
  const { data, error, loading } = useCloud<Earnings>('getRiderEarnings', {
    from: filters.from,
    to: filters.to,
    period: view,
    ...(riderId ? { riderId } : {}),
  });

  const chart = useMemo<Data[]>(() => {
    if (!data) return [];
    const last = data.series.length - 1;
    return [
      {
        type: 'bar',
        x: data.series.map((row) =>
          bucketLabel(row.key, data.period, narrow || data.period === 'week'),
        ),
        y: data.series.map((row) => row.earnings),
        marker: { color: SERIES[0] },
        // Label only the latest period; the rest are in the tooltip and table.
        text: data.series.map((row, i) =>
          i === last ? (narrow ? compactNumber(row.earnings) : money(row.earnings)) : '',
        ),
        constraintext: 'none',
        textposition: 'outside',
        cliponaxis: false,
        textfont: { color: '#0b1633' },
        customdata: data.series.map((row) => [
          money(row.earnings),
          `${bucketLabel(row.key, data.period)} · ${row.deliveries} deliveries`,
        ]),
        hovertemplate: '<b>%{customdata[0]}</b><br>%{customdata[1]}<extra></extra>',
      },
    ];
  }, [data, money, narrow]);
  const layout = useMemo<Partial<Layout>>(
    () => ({
      margin: { l: 8, r: 12, t: 24, b: 8 },
      xaxis: { tickangle: 0, nticks: narrow ? 5 : 12 },
    }),
    [narrow],
  );
  const s = data?.summary;
  const periodName = view === 'week' ? 'Week' : 'Month';

  return (
    <div className={loading ? 'report rider-report busy' : 'report rider-report'}>
      <div className="filter-toggle wide" role="group" aria-label="Summarise by">
        {(
          [
            ['week', 'Weekly'],
            ['month', 'Monthly'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={view === value ? 'active' : ''}
            aria-pressed={view === value}
            onClick={() => switchView(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <FilterBar filters={filters} onChange={setFilters} presets={VIEWS[view].presets} />
      {error && <p className="ops-error">{error}</p>}
      {data && s && (
        <>
          <div className="cash-balance earnings">
            <p>Earnings · {rangeLabel(data.range)}</p>
            <strong>{money(s.earnings)}</strong>
            <span>
              {s.deliveries} deliveries
              {s.earningsChange !== null &&
                ` · ${formatChange(s.earningsChange)} vs ${rangeLabel(data.previousRange)}`}
            </span>
          </div>
          <div className="stat-grid compact">
            <Stat label="Deliveries" value={s.deliveries} change={s.deliveriesChange} />
            <Stat label="Average per delivery" value={money(s.avgPerDelivery)} />
            <Stat label="Order value delivered" value={money(s.sales)} />
            <Stat label="Cash collected" value={money(s.cash)} />
          </div>
          <section className="admin-panel report-panel">
            <div className="panel-title">
              <div>
                <h2>Earnings by {view}</h2>
              </div>
            </div>
            <Chart
              data={chart}
              layout={layout}
              bars={data.series.length}
              height={220}
              label={`Earnings by ${view}`}
              busy={loading}
            />
            <div className="table-scroll">
              <table className="data compact-table">
                <thead>
                  <tr>
                    <th>{periodName}</th>
                    <th className="num">Deliveries</th>
                    <th className="num">Earnings</th>
                    <th className="num">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.series].reverse().map((row) => (
                    <tr key={row.key}>
                      <td className="nowrap">{bucketLabel(row.key, data.period, narrow)}</td>
                      <td className="num">{row.deliveries}</td>
                      <td className="num strong">{money(row.earnings)}</td>
                      <td
                        className={`num ${row.change === null ? '' : row.change < 0 ? 'down' : 'up'}`}
                      >
                        {formatChange(row.change) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <h3 className="section-label">Deliveries</h3>
          {data.deliveries.length > 0 && (
            <div className="table-scroll">
              <table className="data compact-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="num">Earned</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <span className="code">{o.code}</span> · {o.customer}
                        <small>
                          {formatDate(o.deliveredAt, timezone, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </small>
                      </td>
                      <td className="num strong">{money(o.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!data.deliveries.length && (
            <p className="empty-orders">No deliveries in these dates yet.</p>
          )}
        </>
      )}
    </div>
  );
}
