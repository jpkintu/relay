import { useMemo } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useMoney } from '../../lib/session';
import { useDevice } from '../../lib/device';
import { compactNumber } from '../../lib/range';
import { Chart, DOWN, UP } from './Chart';
import { useCloud } from './common';

type Row = { shifts: number; short: number; over: number; net: number; worst: number };
type Trend = {
  days: (Row & { day: string })[];
  cashiers: (Row & { cashier: string })[];
  closedShifts: number;
  shortShifts: number;
};

// Owner: till differences across days (from closed cashier shifts): the net
// short / over per day, and per cashier.
export function TillTrend({ from, to }: { from: string; to: string }) {
  const money = useMoney();
  const narrow = useDevice() === 'phone';
  const { data, loading } = useCloud<{ trend: Trend }>('getShiftReport', { from, to });
  const trend = data?.trend;
  const chart = useMemo<Data[]>(() => {
    if (!trend) return [];
    return [
      {
        type: 'bar',
        // "22 Sep": plain day labels (Plotly would read 2026-09-22 as a number).
        x: trend.days.map((d) =>
          new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          }),
        ),
        y: trend.days.map((d) => d.net),
        marker: { color: trend.days.map((d) => (d.net < 0 ? DOWN : UP)) },
        customdata: trend.days.map((d) => [
          money(d.short),
          money(d.over),
          `${d.shifts} till${d.shifts === 1 ? '' : 's'}`,
        ]),
        hovertemplate:
          '<b>%{x}</b><br>Short %{customdata[0]} · over %{customdata[1]}<br>%{customdata[2]}<extra></extra>',
      },
    ];
  }, [trend, money]);
  const layout = useMemo<Partial<Layout>>(
    () => ({
      xaxis: { type: 'category', tickangle: narrow ? -45 : 0 },
      yaxis: { tickformat: '~s', zeroline: true, zerolinecolor: '#b9bfcc' },
    }),
    [narrow],
  );
  const totalShort = trend?.days.reduce((n, d) => n + d.short, 0) ?? 0;
  const totalOver = trend?.days.reduce((n, d) => n + d.over, 0) ?? 0;
  return (
    <section className="admin-panel report-panel wide">
      <div className="panel-title">
        <div>
          <h2>Till differences</h2>
          <p className="panel-sub">
            {trend && trend.closedShifts > 0
              ? `${trend.shortShifts} of ${trend.closedShifts} closed tills short · ${money(
                  totalShort,
                )} short, ${money(totalOver)} over in these dates`
              : 'Counted cash against the expected till, per day the till was closed'}
          </p>
        </div>
      </div>
      {trend && trend.days.length > 0 ? (
        <>
          <Chart
            data={chart}
            layout={layout}
            bars={trend.days.length}
            label="Net till difference per day"
            busy={loading}
          />
          <p className="muted small">
            Below zero: the till was short (less cash than expected). Above: over.{' '}
            {narrow ? '' : 'Hover a day for its short and over amounts.'}
          </p>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Cashier</th>
                  <th className="num">Tills closed</th>
                  <th className="num">Short</th>
                  <th className="num">Over</th>
                  <th className="num">Net</th>
                  <th className="num">Largest</th>
                </tr>
              </thead>
              <tbody>
                {trend.cashiers.map((c) => (
                  <tr key={c.cashier}>
                    <td>{c.cashier}</td>
                    <td className="num">{c.shifts}</td>
                    <td className="num">{c.short ? money(c.short) : '—'}</td>
                    <td className="num">{c.over ? money(c.over) : '—'}</td>
                    <td className={`num strong ${c.net < 0 ? 'down' : c.net > 0 ? 'up' : ''}`}>
                      {c.net ? money(c.net) : 'Matches'}
                    </td>
                    <td className="num">
                      {c.worst ? (narrow ? compactNumber(c.worst) : money(c.worst)) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="empty-orders">{loading ? 'Loading…' : 'No tills closed in these dates.'}</p>
      )}
    </section>
  );
}
