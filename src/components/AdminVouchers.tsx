import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminRun } from '../lib/adminRun';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { useCloud } from './reports/common';

// Accounting → Refunds & vouchers (vouchers.js): money paid for orders that
// were cancelled. It is the customer's: spent whole on a new order (at the
// counter or online, with their phone number), or refunded less the
// charges for sending it. The owner sets the charges and records refunds;
// finance sees the list.

export type Voucher = {
  id: string;
  code: string;
  kind: 'payment' | 'restore' | 'rest';
  amount: number;
  phone: string;
  customerName: string;
  status: 'open' | 'used' | 'refunded';
  openedAt: string | null;
  sourceOrder: { id: string; code: string } | null;
  fromVoucher: string;
  usedOn: { id: string; code: string } | null;
  usedAt: string | null;
  usedAmount: number;
  charges: number;
  toSend: number;
  refundedAt: string | null;
  refundNote: string;
};

const KIND: Record<Voucher['kind'], string> = {
  payment: 'Paid for a cancelled order',
  restore: 'Voucher given back (order cancelled)',
  rest: 'Left from a voucher',
};

export function AdminVouchers() {
  const money = useMoney();
  const { timezone } = useConfig();
  const { profile } = useSession();
  const owner = profile?.role === 'admin';
  const adminRun = useAdminRun();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useCloud<{
    vouchers: Voucher[];
    charges: { flat: number; percent: number };
  }>('adminListVouchers', {});
  const [flat, setFlat] = useState('');
  const [percent, setPercent] = useState('');
  const [refunding, setRefunding] = useState<Voucher | null>(null);
  const [charges, setCharges] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  useEffect(() => {
    if (!data) return;
    setFlat(String(data.charges.flat || 0));
    setPercent(String(data.charges.percent || 0));
  }, [data]);

  const act = async (name: string, params: Record<string, unknown>, message: string) => {
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await adminRun(name, params);
      setDone(message);
      setRefunding(null);
      reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const vouchers = data?.vouchers ?? [];
  const open = vouchers.filter((v) => v.status === 'open');
  const owed = open.reduce((n, v) => n + v.amount, 0);
  const chargesNow = refunding
    ? charges === ''
      ? refunding.charges
      : Math.max(0, Math.round(Number(charges) || 0))
    : 0;

  return (
    <div className={loading ? 'busy' : ''}>
      {error && <p className="ops-error">{error}</p>}
      <article className="admin-panel statement">
        <h3>Refunds & vouchers</h3>
        <p className="muted small">
          Money paid for orders that were then cancelled is the customer&apos;s. They can spend it
          on a new order (the cashier, or the online checkout, takes the voucher code with their
          phone number): a voucher is used whole, any rest of the bill is paid in cash or mobile
          money, and if the order costs less what is left stays theirs as a new voucher. Or you
          refund it, less the charges for sending it.
        </p>
        <p>
          <b>Owed to customers now: {money(owed)}</b>{' '}
          <span className="muted">
            ({open.length} voucher{open.length === 1 ? '' : 's'})
          </span>
        </p>
        {owner && data && (
          <form
            className="voucher-charges"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'adminSaveRefundCharges',
                { flat: Number(flat) || 0, percent: Number(percent) || 0 },
                'Refund charges saved.',
              );
            }}
          >
            <span>Charges for sending a refund:</span>
            <label>
              Flat
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={flat}
                onChange={(e) => setFlat(e.target.value)}
              />
            </label>
            <label>
              plus %
              <input
                type="number"
                min="0"
                max="50"
                step="0.1"
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
            </label>
            <button className="setup-secondary" disabled={busy}>
              Save
            </button>
          </form>
        )}
        {problem && <p className="ops-error">{problem}</p>}
        {done && <p className="form-success">{done}</p>}
        {refunding && (
          <form
            className="voucher-refund"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'adminRefundVoucher',
                { id: refunding.id, charges: chargesNow, note },
                `${refunding.code} refunded: ${money(refunding.amount - chargesNow)} sent.`,
              );
            }}
          >
            <h4>
              Refund {refunding.code} to{' '}
              {refunding.phone || refunding.customerName || 'the customer'}
            </h4>
            <dl className="voucher-sums">
              <div>
                <dt>Refundable</dt>
                <dd>{money(refunding.amount)}</dd>
              </div>
              <div>
                <dt>Charges for sending it</dt>
                <dd>
                  <input
                    type="number"
                    min="0"
                    max={refunding.amount}
                    inputMode="numeric"
                    value={charges === '' ? String(refunding.charges) : charges}
                    onChange={(e) => setCharges(e.target.value)}
                    aria-label="Charges"
                  />
                </dd>
              </div>
              <div className="strong">
                <dt>Send to the customer</dt>
                <dd>{money(Math.max(0, refunding.amount - chargesNow))}</dd>
              </div>
            </dl>
            <label className="setup-field">
              How it was sent
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. MTN MoMo to 0772 123456, ID 1234567890"
                maxLength={300}
              />
            </label>
            <div className="payment-actions">
              <button disabled={busy || note.trim().length < 5}>Mark refunded</button>
              <button type="button" className="setup-secondary" onClick={() => setRefunding(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Voucher</th>
                <th>Customer</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.id} className={v.status === 'open' ? '' : 'inactive'}>
                  <td data-label="Voucher">
                    <span className="code">{v.code}</span>
                    <small className="block muted">
                      {KIND[v.kind]}
                      {v.sourceOrder && (
                        <>
                          {' '}
                          <button
                            className="link-button"
                            onClick={() => navigate(`/admin/orders/${v.sourceOrder!.id}`)}
                          >
                            {v.sourceOrder.code}
                          </button>
                        </>
                      )}
                      {v.fromVoucher && ` ${v.fromVoucher}`}
                      {v.openedAt && ` · ${formatDate(v.openedAt, timezone)}`}
                    </small>
                  </td>
                  <td data-label="Customer">
                    {v.customerName || '—'}
                    {v.phone && <small className="block">{v.phone}</small>}
                  </td>
                  <td data-label="Amount" className="num">
                    {money(v.amount)}
                  </td>
                  <td data-label="Status">
                    {v.status === 'open' ? (
                      <>
                        <span className="status-pill bad">Owed</span>
                        <small className="block muted">
                          Refund: {money(v.toSend)} after {money(v.charges)} charges
                        </small>
                      </>
                    ) : v.status === 'used' ? (
                      <>
                        <span className="status-pill good">Spent</span>
                        <small className="block muted">
                          {money(v.usedAmount)} on{' '}
                          {v.usedOn ? (
                            <button
                              className="link-button"
                              onClick={() => navigate(`/admin/orders/${v.usedOn!.id}`)}
                            >
                              {v.usedOn.code}
                            </button>
                          ) : (
                            'an order'
                          )}
                          {v.usedAt && ` · ${formatDate(v.usedAt, timezone)}`}
                        </small>
                      </>
                    ) : (
                      <>
                        <span className="status-pill good">Refunded</span>
                        <small className="block muted">
                          {money(v.toSend)} sent, {money(v.charges)} charges
                          {v.refundedAt && ` · ${formatDate(v.refundedAt, timezone)}`}
                          {v.refundNote && ` · ${v.refundNote}`}
                        </small>
                      </>
                    )}
                  </td>
                  <td className="actions-cell">
                    {owner && v.status === 'open' && (
                      <button
                        className="setup-secondary"
                        onClick={() => {
                          setRefunding(v);
                          setCharges('');
                          setNote('');
                          setDone('');
                        }}
                      >
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!vouchers.length && !loading && (
                <tr>
                  <td colSpan={5} className="empty-orders">
                    No vouchers: no paid order has been cancelled.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
