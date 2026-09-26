import { useState } from 'react';
import { Banknote } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { usePin } from '../lib/pin';
import { Stat, useCloud } from './reports/common';

type RiderPay = {
  riderId: string;
  rider: string;
  active: boolean;
  deliveries: number;
  earned: number;
  commission: number;
  deliveryFees: number;
  deductions: number;
  owed: number;
};

type Payout = {
  id: string;
  code: string;
  kind: 'rider' | 'expense';
  amount: number;
  earned: number;
  deliveryFees: number;
  deductions: number;
  orderCount: number;
  note: string;
  rider: string;
  paidBy: string;
  paidAt: string;
};

// Cashier: pay riders what they are owed (commission + delivery fees, less
// any shortage) and record other cash taken from the till. Both lower the
// expected till at the end of the shift.
export function CashierPayouts() {
  const money = useMoney();
  const { timezone } = useConfig();
  const { profile } = useSession();
  const withPin = usePin();
  const isCashier = profile?.role === 'cashier';
  const owed = useCloud<RiderPay[]>('getRiderPay', {});
  const shiftPayouts = useCloud<{ payouts: Payout[]; total: number }>('getTillPayouts', {});
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');

  const reload = () => {
    owed.reload();
    shiftPayouts.reload();
  };

  const firstName = (label: string) => label.split(' · ').pop() || label;

  const pay = async (row: RiderPay) => {
    setNotice('');
    const done = await withPin(
      `Pay ${firstName(row.rider)} ${money(row.owed)}`,
      (pin) => Parse.Cloud.run('payRider', { riderId: row.riderId, pin }),
      'Count the cash out of the till and hand it to the rider, then enter your PIN.',
    );
    if (!done) return;
    setNotice(`Paid ${row.rider} ${money(row.owed)} from the till.`);
    reload();
  };

  const expense = async () => {
    setNotice('');
    const value = Math.round(Number(amount));
    const done = await withPin(`Take ${money(value)} from the till`, (pin) =>
      Parse.Cloud.run('recordTillPayout', { amount: value, note: note.trim(), pin }),
    );
    if (!done) return;
    setNotice(`Recorded ${money(value)}: ${note.trim()}.`);
    setAmount('');
    setNote('');
    reload();
  };

  const toPay = (owed.data || []).filter((row) => row.owed > 0);
  const owedTotal = toPay.reduce((n, row) => n + row.owed, 0);
  const paid = shiftPayouts.data?.payouts ?? [];
  const riderPaid = paid.filter((p) => p.kind === 'rider').reduce((n, p) => n + p.amount, 0);
  const amountValue = Number(amount);
  const canRecord = amount !== '' && amountValue > 0 && note.trim().length >= 5;

  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <h1>Payouts</h1>
        </div>
        <span>Money paid out of the till comes off your expected till.</span>
      </div>
      {notice && <p className="setup-notice">{notice}</p>}
      {owed.error && <p className="ops-error">{owed.error}</p>}

      <div className="stat-grid">
        <Stat
          label="Owed to riders"
          value={money(owedTotal)}
          note={`${toPay.length} rider${toPay.length === 1 ? '' : 's'} · commission + delivery fees`}
        />
        {isCashier && (
          <Stat
            label="Paid out this shift"
            value={money(shiftPayouts.data?.total ?? 0)}
            note={`${money(riderPaid)} rider pay · ${money(
              (shiftPayouts.data?.total ?? 0) - riderPaid,
            )} other`}
          />
        )}
      </div>

      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Riders to pay <small>({toPay.length})</small>
          </h2>
        </div>
        <p className="muted small">
          Commission plus delivery fees for every unpaid delivery, less any cash shortage the owner
          charged to the rider. You can also pay a rider when you confirm their cash handover.
        </p>
        {toPay.length ? (
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th className="num">Deliveries</th>
                  <th className="num">Commission</th>
                  <th className="num">Delivery fees</th>
                  <th className="num">Shortages</th>
                  <th className="num">To pay</th>
                  <th>Pay</th>
                </tr>
              </thead>
              <tbody>
                {toPay.map((row) => (
                  <tr key={row.riderId}>
                    <td data-label="Rider">
                      <b>{row.rider}</b>
                    </td>
                    <td data-label="Deliveries" className="num">
                      {row.deliveries}
                    </td>
                    <td data-label="Commission" className="num">
                      {money(row.commission)}
                    </td>
                    <td data-label="Delivery fees" className="num">
                      {money(row.deliveryFees)}
                    </td>
                    <td data-label="Shortages" className={`num ${row.deductions ? 'down' : ''}`}>
                      {row.deductions ? `− ${money(row.deductions)}` : '—'}
                    </td>
                    <td data-label="To pay" className="num strong">
                      {money(row.owed)}
                    </td>
                    <td data-label="Pay" className="actions-cell">
                      <div className="payment-actions">
                        <button onClick={() => void pay(row)}>
                          <Banknote /> Pay {money(row.owed)}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{toPay.reduce((n, r) => n + r.deliveries, 0)}</td>
                  <td className="num">{money(toPay.reduce((n, r) => n + r.commission, 0))}</td>
                  <td className="num">{money(toPay.reduce((n, r) => n + r.deliveryFees, 0))}</td>
                  <td className="num">{money(toPay.reduce((n, r) => n + r.deductions, 0))}</td>
                  <td className="num strong">{money(owedTotal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="empty-orders">{owed.loading ? 'Loading…' : 'No rider is owed pay.'}</p>
        )}
      </section>

      {isCashier && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Other cash out of the till</h2>
          </div>
          <div className="payout-form">
            <label className="setup-field">
              Amount
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 20000"
              />
            </label>
            <label className="setup-field">
              What it was for
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="e.g. Bought charcoal"
              />
            </label>
            <div className="payment-actions">
              <button disabled={!canRecord} onClick={() => void expense()}>
                Record payout
              </button>
            </div>
          </div>
        </section>
      )}

      {isCashier && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Paid out this shift <small>({paid.length})</small>
            </h2>
          </div>
          {paid.length ? (
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Payout</th>
                    <th>Time</th>
                    <th>For</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {paid.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Payout">
                        <span className="code">{p.code}</span>
                      </td>
                      <td data-label="Time" className="nowrap">
                        {formatDate(p.paidAt, timezone, { timeStyle: 'short' })}
                      </td>
                      <td data-label="For">
                        {p.kind === 'rider' ? (
                          <>
                            <b>Rider pay · {p.rider}</b>
                            <small>
                              {p.orderCount} {p.orderCount === 1 ? 'delivery' : 'deliveries'} ·{' '}
                              {money(p.earned - p.deliveryFees)} commission +{' '}
                              {money(p.deliveryFees)} delivery fees
                              {p.deductions ? ` − ${money(p.deductions)} shortage` : ''}
                            </small>
                          </>
                        ) : (
                          p.note
                        )}
                      </td>
                      <td data-label="Amount" className="num strong">
                        {money(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total paid out</td>
                    <td className="num strong">{money(shiftPayouts.data?.total ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="empty-orders">Nothing paid out this shift.</p>
          )}
        </section>
      )}
    </div>
  );
}
