import { useState } from 'react';
import Parse from '../parse';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { usePin } from '../lib/pin';
import { useCloud } from './reports/common';

type RiderPay = {
  riderId: string;
  rider: string;
  active: boolean;
  deliveries: number;
  earned: number;
  deductions: number;
  owed: number;
};

type Payout = {
  id: string;
  code: string;
  kind: 'rider' | 'expense';
  amount: number;
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

  const pay = async (row: RiderPay) => {
    setNotice('');
    const done = await withPin(
      `Pay ${row.rider.split(' · ').pop()} ${money(row.owed)}`,
      (pin) => Parse.Cloud.run('payRider', { riderId: row.riderId, pin }),
      'Count the cash out of the till and hand it to the rider, then enter your PIN.',
    );
    if (!done) return;
    setNotice(`Paid ${row.rider} ${money(row.owed)}.`);
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
  const amountValue = Number(amount);
  const canRecord = amount !== '' && amountValue > 0 && note.trim().length >= 5;

  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <h1>Payouts</h1>
        </div>
        <span>Money paid out comes off your expected till.</span>
      </div>
      {notice && <p className="setup-notice">{notice}</p>}
      {owed.error && <p className="ops-error">{owed.error}</p>}

      <section className="admin-panel">
        <div className="panel-title">
          <h2>Riders to pay</h2>
        </div>
        <p className="muted">Commission plus delivery fees, less any cash shortage.</p>
        {toPay.length ? (
          <div className="table-scroll">
            <table className="data stack-on-phone">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th className="num">Deliveries</th>
                  <th className="num">Earned</th>
                  <th className="num">Shortages</th>
                  <th className="num">To pay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {toPay.map((row) => (
                  <tr key={row.riderId}>
                    <td data-label="Rider">{row.rider}</td>
                    <td data-label="Deliveries" className="num">
                      {row.deliveries}
                    </td>
                    <td data-label="Earned" className="num">
                      {money(row.earned)}
                    </td>
                    <td data-label="Shortages" className="num">
                      {row.deductions ? `− ${money(row.deductions)}` : '—'}
                    </td>
                    <td data-label="To pay" className="num strong">
                      {money(row.owed)}
                    </td>
                    <td className="actions-cell">
                      <button className="primary-button" onClick={() => void pay(row)}>
                        Pay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-orders">{owed.loading ? 'Loading…' : 'No rider is owed pay.'}</p>
        )}
      </section>

      {isCashier && (
        <section className="admin-panel">
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
            <button className="primary-button" disabled={!canRecord} onClick={() => void expense()}>
              Record payout
            </button>
          </div>
        </section>
      )}

      {isCashier && (
        <section className="admin-panel">
          <div className="panel-title">
            <h2>Paid out this shift</h2>
            <strong>{money(shiftPayouts.data?.total ?? 0)}</strong>
          </div>
          {shiftPayouts.data?.payouts.length ? (
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
                  {shiftPayouts.data.payouts.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Payout" className="mono">
                        {p.code}
                      </td>
                      <td data-label="Time" className="nowrap">
                        {formatDate(p.paidAt, timezone, { timeStyle: 'short' })}
                      </td>
                      <td data-label="For">{p.kind === 'rider' ? `Pay: ${p.rider}` : p.note}</td>
                      <td data-label="Amount" className="num strong">
                        {money(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
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
