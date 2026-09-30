import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { useConfig, useMoney } from '../../lib/session';
import { formatDate } from '../../lib/format';
import { addDays, todayIn } from '../../lib/range';
import { useCloud } from './common';

type Z = {
  day: string;
  orders: {
    placed: number;
    delivered: number;
    cancelled: number;
    avgOrder: number;
    avgDeliveryMinutes: number | null;
    avgCounterMinutes?: number | null;
    byType?: { key: string; orders: number; amount: number }[];
  };
  sales: {
    total: number;
    food: number;
    deliveryFees: number;
    riderCommission: number;
    riderPay: number;
    kept: number;
    riderOrders?: number;
    counterOrders?: number;
  };
  payments: {
    cash: number;
    cashOrders: number;
    mobileMoneyVerified: number;
    mobileMoneyPending: number;
    mobileMoneyRejected: number;
    cardVerified?: number;
    cardPending?: number;
  };
  till: {
    cashReceived: number;
    riderCash?: number;
    counterCash?: number;
    riderPay: number;
    otherPayouts: number;
    disputes: number;
    cashWithRidersNow: number;
  };
  shifts: {
    cashier: string;
    opening: number;
    cashIn: number | null;
    paidOut: number | null;
    expected: number | null;
    counted: number | null;
    variance: number;
    note: string;
  }[];
  riders: {
    rider: string;
    delivered: number;
    sales: number;
    cash: number;
    handedOver: number;
    riderPay: number;
  }[];
  items: { name: string; qty: number; revenue: number }[];
};
type Result = { day: string; live: boolean; savedAt: string | null; report: Z };
type Saved = { day: string; savedAt: string; delivered: number; sales: number; kept: number };

// Owner: the end-of-day summary for one day. Saved every night after the
// Z-report hour (Settings) and pushed to the owner's phone.
export function ZReportPage({ day: wanted }: { day: string }) {
  const money = useMoney();
  const { timezone, restaurantName } = useConfig();
  const navigate = useNavigate();
  const today = todayIn(timezone);
  const day = wanted === 'today' || wanted > today ? today : wanted;
  const { data, error, loading } = useCloud<Result>('adminGetZReport', { day });
  const saved = useCloud<Saved[]>('adminListZReports', {});
  const go = (next: string) => navigate(`/admin/reports/z/${next}`);
  const z = data?.report;
  const heading = formatDate(`${day}T12:00:00Z`, 'UTC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const variance = z ? z.shifts.reduce((n, s) => n + (s.variance || 0), 0) : 0;

  return (
    <div className={loading ? 'report z-report busy' : 'report z-report'}>
      <div className="z-toolbar no-print">
        <button className="back-link" onClick={() => navigate('/admin/reports')}>
          <ArrowLeft /> Reports
        </button>
        <div className="z-day-picker">
          <button
            className="icon-button"
            aria-label="Day before"
            onClick={() => go(addDays(day, -1))}
          >
            <ChevronLeft />
          </button>
          <input
            type="date"
            aria-label="Day"
            value={day}
            max={today}
            onChange={(e) => e.target.value && go(e.target.value)}
          />
          <button
            className="icon-button"
            aria-label="Next day"
            disabled={day >= today}
            onClick={() => go(addDays(day, 1))}
          >
            <ChevronRight />
          </button>
        </div>
        <button className="setup-secondary" onClick={() => window.print()} disabled={!z}>
          <Printer /> Print
        </button>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {z && data && (
        <article className="admin-panel z-sheet">
          <header>
            <p className="eyebrow">{restaurantName} · Z-report</p>
            <h2>{heading}</h2>
            <p className="muted small">
              {data.live
                ? 'Today so far. Saved automatically tonight.'
                : `Saved ${formatDate(data.savedAt || '', timezone, { dateStyle: 'medium', timeStyle: 'short' })}`}
            </p>
          </header>

          <div className="z-grid">
            <section>
              <h3>Sales</h3>
              <dl>
                <div>
                  <dt>Food</dt>
                  <dd>{money(z.sales.food)}</dd>
                </div>
                <div>
                  <dt>Delivery fees</dt>
                  <dd>{money(z.sales.deliveryFees)}</dd>
                </div>
                <div className="total">
                  <dt>Customers paid</dt>
                  <dd>{money(z.sales.total)}</dd>
                </div>
                <div>
                  <dt>Rider commission</dt>
                  <dd>− {money(z.sales.riderCommission)}</dd>
                </div>
                <div>
                  <dt>Delivery fees to riders</dt>
                  <dd>− {money(z.sales.deliveryFees)}</dd>
                </div>
                <div className="total">
                  <dt>Net revenue</dt>
                  <dd>{money(z.sales.kept)}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>Orders</h3>
              <dl>
                <div>
                  <dt>Placed</dt>
                  <dd>{z.orders.placed}</dd>
                </div>
                <div>
                  <dt>Delivered</dt>
                  <dd>{z.orders.delivered}</dd>
                </div>
                <div>
                  <dt>Cancelled</dt>
                  <dd>{z.orders.cancelled}</dd>
                </div>
                <div>
                  <dt>Average order</dt>
                  <dd>{money(z.orders.avgOrder)}</dd>
                </div>
                {(z.orders.byType || [])
                  .filter((k) => k.orders && k.key !== 'delivery')
                  .map((k) => (
                    <div key={k.key}>
                      <dt>{k.key === 'eat_in' ? 'Of which eat in' : 'Of which pick up'}</dt>
                      <dd>
                        {k.orders} · {money(k.amount)}
                      </dd>
                    </div>
                  ))}
                <div>
                  <dt>Order to door</dt>
                  <dd>
                    {z.orders.avgDeliveryMinutes === null
                      ? '—'
                      : `${z.orders.avgDeliveryMinutes} min`}
                  </dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>How customers paid</h3>
              <dl>
                <div>
                  <dt>Cash ({z.payments.cashOrders} orders)</dt>
                  <dd>{money(z.payments.cash)}</dd>
                </div>
                <div>
                  <dt>Mobile money confirmed</dt>
                  <dd>{money(z.payments.mobileMoneyVerified)}</dd>
                </div>
                <div>
                  <dt>Mobile money not yet checked</dt>
                  <dd>{money(z.payments.mobileMoneyPending)}</dd>
                </div>
                {!!(z.payments.cardVerified || z.payments.cardPending) && (
                  <div>
                    <dt>Card confirmed</dt>
                    <dd>{money(z.payments.cardVerified || 0)}</dd>
                  </div>
                )}
                {!!z.payments.cardPending && (
                  <div>
                    <dt>Card not yet checked</dt>
                    <dd>{money(z.payments.cardPending)}</dd>
                  </div>
                )}
                {z.payments.mobileMoneyRejected > 0 && (
                  <div className="bad">
                    <dt>Mobile money not received</dt>
                    <dd>{z.payments.mobileMoneyRejected} orders</dd>
                  </div>
                )}
              </dl>
            </section>
            <section>
              <h3>Cash</h3>
              <dl>
                <div>
                  <dt>Counted in from riders</dt>
                  <dd>
                    {money(z.till.riderCash ?? z.till.cashReceived - (z.till.counterCash || 0))}
                  </dd>
                </div>
                {!!z.till.counterCash && (
                  <div>
                    <dt>Taken at the counter</dt>
                    <dd>{money(z.till.counterCash)}</dd>
                  </div>
                )}
                <div>
                  <dt>Rider pay from tills</dt>
                  <dd>− {money(z.till.riderPay)}</dd>
                </div>
                <div>
                  <dt>Other payouts</dt>
                  <dd>− {money(z.till.otherPayouts)}</dd>
                </div>
                <div className={variance ? 'bad' : ''}>
                  <dt>Till differences</dt>
                  <dd>
                    {variance === 0
                      ? 'None'
                      : `${variance > 0 ? '+' : '−'} ${money(Math.abs(variance))}`}
                  </dd>
                </div>
                {z.till.disputes > 0 && (
                  <div className="bad">
                    <dt>Disputed handovers</dt>
                    <dd>{z.till.disputes}</dd>
                  </div>
                )}
                <div>
                  <dt>Cash still with riders{data.live ? '' : ' (when saved)'}</dt>
                  <dd>{money(z.till.cashWithRidersNow)}</dd>
                </div>
              </dl>
            </section>
          </div>

          {z.shifts.length > 0 && (
            <section>
              <h3>Tills closed</h3>
              <div className="table-scroll">
                <table className="data stack-on-phone">
                  <thead>
                    <tr>
                      <th>Cashier</th>
                      <th className="num">Opening</th>
                      <th className="num">Cash in</th>
                      <th className="num">Paid out</th>
                      <th className="num">Expected</th>
                      <th className="num">Counted</th>
                      <th className="num">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.shifts.map((s, i) => (
                      <tr key={i}>
                        <td data-label="Cashier">
                          {s.cashier}
                          {s.note && <small>{s.note}</small>}
                        </td>
                        <td data-label="Opening" className="num">
                          {money(s.opening)}
                        </td>
                        <td data-label="Cash in" className="num">
                          {s.cashIn === null ? '—' : money(s.cashIn)}
                        </td>
                        <td data-label="Paid out" className="num">
                          {s.paidOut === null ? '—' : money(s.paidOut)}
                        </td>
                        <td data-label="Expected" className="num">
                          {s.expected === null ? '—' : money(s.expected)}
                        </td>
                        <td data-label="Counted" className="num">
                          {s.counted === null ? '—' : money(s.counted)}
                        </td>
                        <td data-label="Difference" className={`num ${s.variance ? 'down' : ''}`}>
                          {s.variance
                            ? `${s.variance > 0 ? '+' : '−'} ${money(Math.abs(s.variance))}`
                            : 'Matched'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h3>Riders</h3>
            {z.riders.length ? (
              <div className="table-scroll">
                <table className="data stack-on-phone">
                  <thead>
                    <tr>
                      <th>Rider</th>
                      <th className="num">Delivered</th>
                      <th className="num">Sales</th>
                      <th className="num">Cash collected</th>
                      <th className="num">Cash handed over</th>
                      <th className="num">Rider pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.riders.map((r) => (
                      <tr key={r.rider}>
                        <td data-label="Rider">{r.rider}</td>
                        <td data-label="Delivered" className="num">
                          {r.delivered}
                        </td>
                        <td data-label="Sales" className="num">
                          {money(r.sales)}
                        </td>
                        <td data-label="Cash collected" className="num">
                          {money(r.cash)}
                        </td>
                        <td data-label="Cash handed over" className="num">
                          {money(r.handedOver)}
                        </td>
                        <td data-label="Rider pay" className="num">
                          {money(r.riderPay)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted small">No deliveries.</p>
            )}
          </section>

          {z.items.length > 0 && (
            <section>
              <h3>Top dishes</h3>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Dish</th>
                      <th className="num">Sold</th>
                      <th className="num">Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.items.map((item) => (
                      <tr key={item.name}>
                        <td>{item.name}</td>
                        <td className="num">{item.qty}</td>
                        <td className="num">{money(item.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </article>
      )}

      {saved.data && saved.data.length > 0 && (
        <section className="admin-panel admin-section-panel no-print">
          <div className="panel-title">
            <h2>Saved Z-reports</h2>
          </div>
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Delivered</th>
                  <th className="num">Sales</th>
                  <th className="num">Net revenue</th>
                </tr>
              </thead>
              <tbody>
                {saved.data.map((row) => (
                  <tr
                    key={row.day}
                    className={`clickable ${row.day === day ? 'selected' : ''}`}
                    tabIndex={0}
                    onClick={() => go(row.day)}
                    onKeyDown={(e) => e.key === 'Enter' && go(row.day)}
                  >
                    <td data-label="Day">
                      {formatDate(`${row.day}T12:00:00Z`, 'UTC', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </td>
                    <td data-label="Delivered" className="num">
                      {row.delivered}
                    </td>
                    <td data-label="Sales" className="num">
                      {money(row.sales)}
                    </td>
                    <td data-label="Net revenue" className="num strong">
                      {money(row.kept)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
