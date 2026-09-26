import { useCallback, useEffect, useState } from 'react';
import { Check, HandCoins } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { personLabel } from '../lib/people';
import { usePin } from '../lib/pin';

type Handover = {
  id: string;
  code: string;
  rider: string;
  amount: number;
  orderCount: number;
  createdAt: Date;
  // `pay`: the delivery fee still owed to the rider for the order (paid at
  // the handover if the cashier chooses; commission is paid later).
  orders: { id: string; code: string; amount: number; pay: number }[];
};

// Matches the server: handovers waiting longer than this are flagged.
const STALE_HOURS = 4;
const hoursWaiting = (date: Date) => Math.floor((Date.now() - date.getTime()) / 3600000);
export function CashierHandovers({ preview }: { preview: boolean }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const withPin = usePin();
  const [rows, setRows] = useState<Handover[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [counted, setCounted] = useState(''),
    [reason, setReason] = useState(''),
    [received, setReceived] = useState<string[]>([]),
    [payNow, setPayNow] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const q = new Parse.Query('CashHandover');
      q.equalTo('status', 'pending');
      q.ascending('createdAt');
      q.include('rider');
      q.limit(100);
      const found = await q.find();
      // The list refreshes every 10 s; keep the order lines already loaded
      // for a handover so an open count dialog does not lose them.
      setRows((prev) =>
        found.map((h) => ({
          id: h.id!,
          code: h.get('handoverCode'),
          rider: personLabel(h.get('rider')),
          amount: h.get('amount'),
          orderCount: h.get('orderCount'),
          createdAt: h.get('handedOverAt') || h.createdAt || new Date(),
          orders: prev.find((row) => row.id === h.id)?.orders ?? [],
        })),
      );
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load handovers');
    }
  }, [preview]);
  useEffect(() => {
    void load();
    if (preview) return;
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load, preview]);
  const open = async (row: Handover) => {
    setSelected(row.id);
    setCounted('');
    setReason('');
    setReceived([]);
    setPayNow(false);
    if (preview) return;
    try {
      const q = new Parse.Query('CashHandover');
      const handover = await q.get(row.id);
      const pointers = handover.get('orders') || [];
      const orders = await Promise.all(pointers.map((p: Parse.Object) => p.fetch()));
      setReceived(orders.map((o: Parse.Object) => o.id!));
      setRows((prev) =>
        prev.map((h) =>
          h.id === row.id
            ? {
                ...h,
                orders: orders.map((o: Parse.Object) => ({
                  id: o.id!,
                  code: o.get('orderCode'),
                  amount: o.get('amountCollected'),
                  pay:
                    o.get('commissionPaid') || o.get('deliveryFeePaid')
                      ? 0
                      : Number(o.get('deliveryPay') ?? o.get('deliveryFee') ?? 0),
                })),
              }
            : h,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load handover orders');
    }
  };
  const submit = async (action: 'confirmHandover' | 'disputeHandover') => {
    if (!selected || preview) return;
    const amount = Number(counted);
    if (counted.trim() === '' || !Number.isFinite(amount) || amount < 0) {
      setError('Enter the physical cash count');
      return;
    }
    if (action === 'disputeHandover' && reason.trim().length < 5) {
      setError('Describe the discrepancy in at least 5 characters');
      return;
    }
    setBusy(true);
    setError('');
    const params = {
      handoverId: selected,
      countedAmount: amount,
      reason,
      ...(action === 'confirmHandover' && { receivedOrderIds: received }),
    };
    type Result = { returned?: number; paid?: number; payProblem?: string } | undefined;
    try {
      let result: Result;
      if (action === 'confirmHandover' && payNow) {
        // Paying out of the till needs the PIN.
        const done = await withPin(
          `Confirm and pay ${money(payTotal)} delivery fees`,
          async (pin) => {
            result = await Parse.Cloud.run(action, { ...params, payRider: true, pin });
          },
          'After counting the cash, take the delivery fees out of the till and hand them to the rider, then enter your PIN.',
        );
        if (!done) return;
      } else {
        result = await Parse.Cloud.run(action, params);
      }
      const r = result as Result;
      setSelected(null);
      setNotice(
        action === 'disputeHandover'
          ? 'Dispute recorded for owner review.'
          : [
              'Cash receipt confirmed.',
              r?.returned
                ? `${r.returned} ${
                    r.returned === 1 ? 'order went' : 'orders went'
                  } back to the rider to hand over again.`
                : '',
              r?.paid ? `Paid the rider ${money(r.paid)} in delivery fees from the till.` : '',
              r?.payProblem ? `Rider not paid: ${r.payProblem}.` : '',
            ]
              .filter(Boolean)
              .join(' '),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process handover');
    } finally {
      setBusy(false);
    }
  };
  const current = rows.find((h) => h.id === selected);
  const tickedTotal = current
    ? current.orders.filter((o) => received.includes(o.id)).reduce((n, o) => n + o.amount, 0)
    : 0;
  const countedValue = counted.trim() === '' ? null : Number(counted);
  const payTotal = current
    ? current.orders.filter((o) => received.includes(o.id)).reduce((n, o) => n + o.pay, 0)
    : 0;
  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <h1>Cash handovers</h1>
        </div>
        <span>{rows.length} awaiting review</span>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview && (
        <p className="setup-notice">
          Cash handovers require signed-in riders and cashiers. Demo orders do not move real cash.
        </p>
      )}
      {rows.map((row) => (
        <article
          className={hoursWaiting(row.createdAt) >= STALE_HOURS ? 'handover stale' : 'handover'}
          key={row.id}
        >
          <div className="handover-code">
            <HandCoins />
            <div>
              <b>{row.code}</b>
              <span>{formatDate(row.createdAt, timezone)}</span>
              {hoursWaiting(row.createdAt) >= STALE_HOURS && (
                <em className="stale-tag">Waiting {hoursWaiting(row.createdAt)} h</em>
              )}
            </div>
          </div>
          <div>
            <span>Rider</span>
            <strong>{row.rider}</strong>
          </div>
          <div>
            <span>Orders</span>
            <strong>{row.orderCount}</strong>
          </div>
          <div className="handover-amount">
            <span>Amount claimed</span>
            <strong>{money(row.amount)}</strong>
          </div>
          <button onClick={() => void open(row)}>Count cash</button>
        </article>
      ))}
      {!rows.length && !preview && (
        <p className="empty-orders">No handovers waiting for confirmation.</p>
      )}
      {current && (
        <div className="cash-modal-backdrop">
          <section
            className="cash-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Count cash handover"
          >
            <div className="panel-title">
              <div>
                <p className="eyebrow">
                  {current.code} · {current.rider}
                </p>
                <h2>Count physical cash</h2>
              </div>
              <button className="setup-secondary" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <p>
              Rider claims <strong>{money(current.amount)}</strong> across {current.orderCount}{' '}
              orders. Untick any order whose cash you did not get: it goes back to the rider to hand
              over again.
            </p>
            <div className="handover-orders">
              {current.orders.map((o) => (
                <label className="cash-order" key={o.id}>
                  <input
                    type="checkbox"
                    checked={received.includes(o.id)}
                    onChange={() =>
                      setReceived((ids) =>
                        ids.includes(o.id) ? ids.filter((id) => id !== o.id) : [...ids, o.id],
                      )
                    }
                  />
                  <span>{o.code}</span>
                  <b>{money(o.amount)}</b>
                </label>
              ))}
              <div className="cash-order ticked-total">
                <span>Ticked orders</span>
                <b>{money(tickedTotal)}</b>
              </div>
            </div>
            <label className="setup-field">
              Cash physically received
              <input
                type="number"
                min="0"
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder="Enter counted amount"
              />
            </label>
            {countedValue !== null && countedValue !== tickedTotal && (
              <p className="till-difference short">
                {countedValue < tickedTotal
                  ? `${money(tickedTotal - countedValue)} missing: untick the orders not paid in, or flag a dispute.`
                  : `That is ${money(countedValue - tickedTotal)} more than the ticked orders.`}
              </p>
            )}
            {payTotal > 0 && (
              <label className="pay-now">
                <input
                  type="checkbox"
                  checked={payNow}
                  onChange={(e) => setPayNow(e.target.checked)}
                />
                <span>
                  Pay the rider&apos;s delivery fees now: <b>{money(payTotal)}</b> for these orders.
                  Their commission is paid later from Payouts. It is recorded as a payout from your
                  till.
                </span>
              </label>
            )}
            <label className="setup-field">
              Dispute reason, if cash is missing
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Describe what you counted and why it differs"
              />
            </label>
            <div className="cash-modal-actions">
              <button
                disabled={busy || !received.length || countedValue !== tickedTotal}
                onClick={() => void submit('confirmHandover')}
              >
                <Check /> {payNow ? 'Confirm and pay rider' : 'Confirm received'}
              </button>
              <button
                disabled={
                  busy ||
                  countedValue === null ||
                  countedValue >= current.amount ||
                  reason.trim().length < 5
                }
                onClick={() => void submit('disputeHandover')}
              >
                Flag dispute
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
