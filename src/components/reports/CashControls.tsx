import { useState } from 'react';
import Parse from '../../parse';
import { useConfig, useMoney } from '../../lib/session';
import { formatDate } from '../../lib/format';
import { useCloud } from './common';
import type { RiderOption } from './common';

type Payout = {
  id: string;
  code: string;
  kind: 'rider' | 'expense';
  amount: number;
  earned: number;
  deductions: number;
  orderCount: number;
  note: string;
  rider: string;
  paidBy: string;
  fromTill: boolean;
  paidAt: string;
};

// Owner: everything paid out of tills (rider pay, expenses) in the dates.
export function PayoutsPanel({ from, to }: { from: string; to: string }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const { data, error } = useCloud<{ payouts: Payout[]; total: number }>('getTillPayouts', {
    from,
    to,
  });
  return (
    <section className="admin-panel admin-section-panel">
      <div className="panel-title">
        <h2>
          Payouts <small>({data?.payouts.length ?? 0})</small>
        </h2>
        {data && <strong>{money(data.total)}</strong>}
      </div>
      <p className="muted small">
        Rider pay (commission + delivery fees, less shortages) and other cash taken out of a till.
        Each lowers that cashier&apos;s expected till.
      </p>
      {error && <p className="ops-error">{error}</p>}
      {data?.payouts.length ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Payout</th>
                <th>When</th>
                <th>For</th>
                <th>Paid by</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.payouts.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="code">{p.code}</span>
                  </td>
                  <td className="nowrap">
                    {formatDate(p.paidAt, timezone, { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td>
                    {p.kind === 'rider' ? (
                      <>
                        Pay: {p.rider}
                        <small>
                          {p.orderCount} deliveries · {money(p.earned)}
                          {p.deductions ? ` − ${money(p.deductions)} shortage` : ''}
                        </small>
                      </>
                    ) : (
                      p.note
                    )}
                  </td>
                  <td>
                    {p.paidBy}
                    {!p.fromTill && <small>Not from a till</small>}
                  </td>
                  <td className="num strong">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        data && <p className="empty-orders">No payouts in these dates.</p>
      )}
    </section>
  );
}

type CheckResult = {
  checkedAt: string;
  ok: boolean;
  problems: { kind: string; message: string }[];
};

// Owner: run the cash check now (it also runs nightly as a Cloud Job).
export function CashCheckPanel() {
  const { timezone } = useConfig();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await Parse.Cloud.run('adminRunCashCheck'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cash check failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel admin-section-panel cash-check">
      <div className="panel-title">
        <h2>Cash check</h2>
        <button className="setup-secondary" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Run cash check'}
        </button>
      </div>
      <p className="muted small">
        Confirms that orders, handovers and shifts agree with each other. It also runs every night
        if the &quot;cashCheck&quot; job is scheduled in Back4App.
      </p>
      {error && <p className="ops-error">{error}</p>}
      {result &&
        (result.ok ? (
          <p className="till-difference ok">
            All cash records agree ({formatDate(result.checkedAt, timezone)}).
          </p>
        ) : (
          <ul className="check-problems">
            {result.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}

// Owner: take a rider's cash in person when they cannot reach the counter.
export function ReceiveCash({ riders, onDone }: { riders: RiderOption[]; onDone: () => void }) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [riderId, setRiderId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await Parse.Cloud.run('adminReceiveCash', { riderId, note: note.trim() });
      setMessage(`Received ${money(result.amount)}.`);
      setOpen(false);
      setNote('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the cash');
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="receive-cash">
        {message && <span className="muted">{message}</span>}
        <button className="setup-secondary" onClick={() => setOpen(true)}>
          Take cash from a rider
        </button>
      </div>
    );
  return (
    <div className="dispute-panel receive-cash-form">
      <strong>Take a rider&apos;s cash in person</strong>
      <p className="muted small">
        Records all the cash the rider holds as received by you. It does not go into a
        cashier&apos;s till.
      </p>
      <label>
        Rider
        <select value={riderId} onChange={(e) => setRiderId(e.target.value)}>
          <option value="">Choose a rider</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Where the cash is
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Owner collected it at the stage"
        />
      </label>
      <div className="dispute-actions">
        <button disabled={busy || !riderId || note.trim().length < 5} onClick={() => void submit()}>
          Record cash received
        </button>
        <button className="setup-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}
