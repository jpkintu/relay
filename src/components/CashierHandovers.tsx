import { useCallback, useEffect, useState } from 'react';
import { Check, HandCoins } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { personLabel } from '../lib/people';

type Handover = {
  id: string;
  code: string;
  rider: string;
  amount: number;
  orderCount: number;
  createdAt: Date;
  orders: { code: string; amount: number }[];
};
export function CashierHandovers({ preview }: { preview: boolean }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [rows, setRows] = useState<Handover[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [counted, setCounted] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const q = new Parse.Query('CashHandover');
      q.equalTo('status', 'pending');
      q.descending('createdAt');
      q.include('rider');
      q.limit(100);
      const found = await q.find();
      setRows(
        found.map((h) => ({
          id: h.id!,
          code: h.get('handoverCode'),
          rider: personLabel(h.get('rider')),
          amount: h.get('amount'),
          orderCount: h.get('orderCount'),
          createdAt: h.createdAt || new Date(),
          orders: [],
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
    if (preview) return;
    try {
      const q = new Parse.Query('CashHandover');
      const handover = await q.get(row.id);
      const pointers = handover.get('orders') || [];
      const orders = await Promise.all(pointers.map((p: Parse.Object) => p.fetch()));
      setRows((prev) =>
        prev.map((h) =>
          h.id === row.id
            ? {
                ...h,
                orders: orders.map((o: Parse.Object) => ({
                  code: o.get('orderCode'),
                  amount: o.get('amountCollected'),
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
    try {
      await Parse.Cloud.run(action, { handoverId: selected, countedAmount: amount, reason });
      setSelected(null);
      setNotice(
        action === 'confirmHandover'
          ? 'Cash receipt confirmed.'
          : 'Dispute recorded for owner review.',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process handover');
    } finally {
      setBusy(false);
    }
  };
  const current = rows.find((h) => h.id === selected);
  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <p className="eyebrow">Reconciliation</p>
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
        <article className="handover" key={row.id}>
          <div className="handover-code">
            <HandCoins />
            <div>
              <b>{row.code}</b>
              <span>{formatDate(row.createdAt, timezone)}</span>
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
              orders.
            </p>
            {current.orders.map((o) => (
              <div className="cash-order" key={o.code}>
                <span>{o.code}</span>
                <b>{money(o.amount)}</b>
              </div>
            ))}
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
            <label className="setup-field">
              Dispute reason, if amounts differ
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Describe what you counted and why it differs"
              />
            </label>
            <div className="cash-modal-actions">
              <button
                disabled={busy || !counted || Number(counted) !== current.amount}
                onClick={() => void submit('confirmHandover')}
              >
                <Check /> Confirm received
              </button>
              <button
                disabled={busy || !counted || reason.trim().length < 5}
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
