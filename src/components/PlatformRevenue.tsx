import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import Parse from '../parse';
import { formatDate, formatMoney } from '../lib/format';
import { Chart, SERIES } from './reports/Chart';

// Relay Hosted, platform console: Relay's own revenue. Money received by
// month, monthly recurring revenue, trial-to-paid conversion, who pays next
// and who is late (cloud/platformRevenue.js).

type Due = {
  id: string;
  name: string;
  code: string;
  plan: string;
  amount: number;
  dueAt: string;
  kind?: 'trial_ends' | 'renewal';
  closesAt?: string;
};
type Revenue = {
  currency: string;
  months: { month: string; amount: number; payments: number }[];
  thisMonth: number;
  lastMonth: number;
  allTime: number;
  mrr: number;
  restaurants: number;
  status: Record<string, number>;
  plans: { name: string; restaurants: number; mrr: number }[];
  conversion: { converted: number; eligible: number };
  upcoming: Due[];
  dueIn30Days: number;
  overdue: Due[];
  overdueAmount: number;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const monthLabel = (key: string, style: 'short' | 'long' = 'short') =>
  formatDate(`${key}-15T12:00:00Z`, 'UTC', { month: style, year: 'numeric' });

export function PlatformRevenue({ timeZone }: { timeZone: string }) {
  const [data, setData] = useState<Revenue | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await Parse.Cloud.run('platformRevenue'));
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const money = useCallback(
    (amount: number) => formatMoney(amount, data?.currency || 'UGX'),
    [data?.currency],
  );
  const day = (value: string) => formatDate(value, timeZone, { dateStyle: 'medium' });

  const chart: Data[] = useMemo(
    () =>
      data
        ? [
            {
              type: 'bar',
              x: data.months.map((m) => monthLabel(m.month)),
              y: data.months.map((m) => m.amount),
              marker: { color: SERIES[0] },
              customdata: data.months.map((m) => [
                money(m.amount),
                m.payments,
                monthLabel(m.month, 'long'),
              ]),
              hovertemplate:
                '<b>%{customdata[0]}</b><br>%{customdata[2]} · %{customdata[1]} payments<extra></extra>',
            },
          ]
        : [],
    [data, money],
  );
  const axis: Partial<Layout> = useMemo(() => ({ xaxis: { tickangle: 0 } }), []);

  if (error)
    return (
      <section className="admin-panel">
        <p className="ops-error">{error}</p>
      </section>
    );
  if (!data)
    return (
      <section className="admin-panel">
        <p className="muted">Loading revenue…</p>
      </section>
    );

  const change = data.lastMonth
    ? Math.round(((data.thisMonth - data.lastMonth) / data.lastMonth) * 100)
    : null;
  const paying = (data.status.active || 0) + (data.status.past_due || 0);
  const rate = data.conversion.eligible
    ? Math.round((data.conversion.converted / data.conversion.eligible) * 100)
    : null;

  return (
    <section className="admin-panel platform-revenue">
      <div className="panel-title">
        <div>
          <h2>Revenue</h2>
          <p className="muted">
            Subscription money received, what paying restaurants bring in each month, and who pays
            next.
          </p>
        </div>
        <button className="link-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="admin-metrics">
        <article>
          <span>Received this month</span>
          <strong>{money(data.thisMonth)}</strong>
          <small>
            {change === null
              ? `Last month ${money(data.lastMonth)}`
              : `${change >= 0 ? '+' : '−'}${Math.abs(change)}% on last month (${money(data.lastMonth)})`}
          </small>
        </article>
        <article>
          <span>Monthly recurring revenue</span>
          <strong>{money(data.mrr)}</strong>
          <small>{money(data.mrr * 12)} a year at this rate</small>
        </article>
        <article>
          <span>Paying restaurants</span>
          <strong>{paying}</strong>
          <small>
            of {data.restaurants} · {data.status.trial || 0} on trial · {data.status.expired || 0}{' '}
            closed
          </small>
        </article>
        <article>
          <span>Trial to paid</span>
          <strong>{rate === null ? '—' : `${rate}%`}</strong>
          <small>
            {data.conversion.converted} of {data.conversion.eligible} whose trial ended
          </small>
        </article>
        <article>
          <span>Due in the next 30 days</span>
          <strong>{money(data.dueIn30Days)}</strong>
          <small>
            {data.upcoming.length} renewal{data.upcoming.length === 1 ? '' : 's'} or trial
            {data.upcoming.length === 1 ? '' : 's'} ending
          </small>
        </article>
        <article className={data.overdue.length ? 'metric-alert' : ''}>
          <span>Overdue</span>
          <strong>{money(data.overdueAmount)}</strong>
          <small>
            {data.overdue.length} restaurant{data.overdue.length === 1 ? '' : 's'} in grace days
          </small>
        </article>
      </div>

      <div className="revenue-chart">
        <h3>Received per month</h3>
        <Chart data={chart} layout={axis} bars={12} height={240} label="Money received per month" />
        <small className="muted">All time: {money(data.allTime)}</small>
      </div>

      <div className="revenue-tables">
        <div>
          <h3>Coming up (30 days)</h3>
          {data.upcoming.length ? (
            <div className="table-scroll">
              <table className="data compact-table">
                <thead>
                  <tr>
                    <th>Restaurant</th>
                    <th>When</th>
                    <th className="num">A month</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcoming.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.name}
                        <small className="muted block">{row.plan}</small>
                      </td>
                      <td>
                        {day(row.dueAt)}
                        <small className="muted block">
                          {row.kind === 'trial_ends' ? 'Trial ends' : 'Renewal'}
                        </small>
                      </td>
                      <td className="num">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Nothing due in the next 30 days.</p>
          )}
        </div>
        <div>
          <h3>Overdue</h3>
          {data.overdue.length ? (
            <div className="table-scroll">
              <table className="data compact-table">
                <thead>
                  <tr>
                    <th>Restaurant</th>
                    <th>Was due</th>
                    <th>Closes</th>
                    <th className="num">A month</th>
                  </tr>
                </thead>
                <tbody>
                  {data.overdue.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.name}
                        <small className="muted block">{row.plan}</small>
                      </td>
                      <td>{day(row.dueAt)}</td>
                      <td>{row.closesAt ? day(row.closesAt) : ''}</td>
                      <td className="num">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No restaurant is late.</p>
          )}
          {data.plans.length > 0 && (
            <>
              <h3>By plan</h3>
              <div className="table-scroll">
                <table className="data compact-table">
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th className="num">Paying</th>
                      <th className="num">A month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plans.map((plan) => (
                      <tr key={plan.name}>
                        <td>{plan.name}</td>
                        <td className="num">{plan.restaurants}</td>
                        <td className="num">{money(plan.mrr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
