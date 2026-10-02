import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { groupBySplit, sidesLabel } from '../lib/cart';
import { statusLabel, statusTone } from '../lib/labels';
import { actionLabel, changedFields } from '../lib/audit';
import { useCloud, useRiderOptions } from './reports/common';
import { PAYMENT_STATUS_LABEL, providerLabel } from './MobileMoney';
import { STATUS_LABEL } from './reports/PaymentsLedger';
import { PinPreview } from './MapPin';
import { usePrint } from '../lib/print';

type OrderPage = {
  id: string;
  code: string;
  status: string;
  channel: string;
  location: { lat: number; lng: number } | null;
  rider: { id: string; name: string };
  cashier: string;
  customer: { name: string; phone: string; address: string; notes: string };
  items: {
    id: string;
    name: string;
    qty: number;
    price: number;
    total: number;
    notes: string;
    accompaniments: string[];
    accompanimentPrices?: number[];
    split?: string;
  }[];
  splits?: string[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  payment: {
    method: string;
    provider: string;
    reference: string;
    status: string;
    checkedBy: string;
    rejectReason: string;
    paidAtDoor: boolean;
    amountCollected: number;
    cashStatus: string;
    auto?: boolean;
    requestStatus?: string;
    requestReference?: string;
    requestPhone?: string;
    requestError?: string;
    refundDue?: boolean;
    refundedAt?: string | null;
    refundNote?: string;
    // Vouchers it left (cancelled after paying), and one it was paid with.
    vouchers?: {
      id: string;
      code: string;
      amount: number;
      status: 'open' | 'used' | 'refunded';
      charges: number;
      toSend: number;
      usedOn: { id: string; code: string } | null;
    }[];
    voucherAmount?: number;
    voucherCode?: string;
  };
  riderPay: {
    total: number;
    commission: number | null;
    deliveryFee: number | null;
    paid: boolean;
    feePaid: boolean;
  } | null;
  times: Record<string, string | null>;
  cancelledReason: string;
  cancelledBy: string;
  handovers: { id: string; code: string; status: string; cashier: string; at: string }[];
  history: {
    id: string;
    at: string;
    action: string;
    actor: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }[];
  efris: {
    status: 'issued' | 'failed' | 'pending' | 'not_due';
    fdn: string;
    verification: string;
    issuedAt: string | null;
    error: string;
    test: boolean;
  } | null;
  can: {
    cancel: boolean;
    deliver: boolean;
    move: boolean;
    reopen: boolean;
    paymentToMobileMoney: boolean;
    paymentToCash: boolean;
    refunded?: boolean;
  };
};

type Action = 'cancel' | 'deliver' | 'move' | 'reopen' | 'toMomo' | 'toCash' | 'refunded';

const ACTIONS: { id: Action; label: string; help: string; danger?: boolean }[] = [
  {
    id: 'deliver',
    label: 'Mark delivered',
    help: 'For an order the customer received but the rider could not close (e.g. phone died).',
  },
  {
    id: 'move',
    label: 'Move to another rider',
    help: 'The order and any cash to collect go to the rider you choose.',
  },
  {
    id: 'toMomo',
    label: 'Change to mobile money',
    help: 'The customer paid by mobile money, not cash. A cashier confirms the transaction.',
  },
  {
    id: 'toCash',
    label: 'Change to cash',
    help: 'The customer paid cash. The rider owes the total until they hand it over.',
  },
  {
    id: 'reopen',
    label: 'Undo the delivery',
    help: 'Opens the order again as out for delivery. Only while the money is still with the rider and their pay is unpaid.',
  },
  {
    id: 'refunded',
    label: 'Mark refunded',
    help: 'The customer paid for a cancelled order and wants the money back rather than a voucher. Send it less the refund charges (Accounting → Refunds & vouchers), then say how (e.g. MTN MoMo to 0772…, ID 123…).',
  },
  {
    id: 'cancel',
    label: 'Cancel the order',
    help: 'Stops the order at any stage before delivery. If mobile money was confirmed, refund the customer.',
    danger: true,
  },
];

const CASH_STATE: Record<string, string> = {
  NOT_COLLECTED: 'Not collected yet',
  NOT_APPLICABLE: 'No cash',
};

const TIMES: [string, string][] = [
  ['placed', 'Placed'],
  ['accepted', 'Accepted'],
  ['ready', 'Ready'],
  ['pickedUp', 'Picked up'],
  ['delivered', 'Delivered'],
  ['cancelled', 'Cancelled'],
];

// Owner: one order in full, its history, and overrides.
export function AdminOrder({ id, onChanged }: { id: string; onChanged: () => void }) {
  const money = useMoney();
  const { timezone, mobileMoney = [] } = useConfig();
  const navigate = useNavigate();
  const riders = useRiderOptions();
  const { data: o, error, reload } = useCloud<OrderPage>('adminGetOrder', { id });
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [riderId, setRiderId] = useState('');
  const [provider, setProvider] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const { print, printError } = usePrint();

  const when = (value: string | null) =>
    value ? formatDate(value, timezone, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const back = (
    <button className="back-link" onClick={() => navigate('/admin/orders')}>
      <ArrowLeft /> Orders
    </button>
  );
  if (error)
    return (
      <div className="member-page">
        {back}
        <p className="ops-error">{error}</p>
      </div>
    );
  if (!o)
    return (
      <div className="member-page">
        {back}
        <p className="muted">Loading…</p>
      </div>
    );

  const available: Record<Action, boolean> = {
    cancel: o.can.cancel,
    deliver: o.can.deliver,
    move: o.can.move,
    reopen: o.can.reopen,
    toMomo: o.can.paymentToMobileMoney,
    toCash: o.can.paymentToCash,
    refunded: !!o.can.refunded,
  };
  const choices = ACTIONS.filter((a) => available[a.id]);
  const chosen = ACTIONS.find((a) => a.id === action);
  const needsMomo = action === 'toMomo' || (action === 'deliver' && provider !== '');
  const ready =
    reason.trim().length >= 5 &&
    (action !== 'move' || riderId) &&
    (action !== 'toMomo' || (provider && reference.trim()));

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    setActionError('');
    try {
      const base = { id: o.id, reason: reason.trim() };
      const params =
        action === 'toMomo'
          ? { ...base, action: 'payment', method: 'mobile_money', provider, reference }
          : action === 'toCash'
            ? { ...base, action: 'payment', method: 'cash' }
            : action === 'move'
              ? { ...base, action, riderId }
              : action === 'deliver' && provider
                ? { ...base, action, method: 'mobile_money', provider, reference }
                : { ...base, action };
      await Parse.Cloud.run('adminOverrideOrder', params);
      setNotice(
        action === 'refunded'
          ? 'Marked refunded.'
          : `${chosen?.label}: done. The rider has been told.`,
      );
      setAction(null);
      setReason('');
      setRiderId('');
      setProvider('');
      setReference('');
      reload();
      onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not change the order');
    } finally {
      setBusy(false);
    }
  };

  const p = o.payment;
  const paymentState =
    p.method === 'cash'
      ? CASH_STATE[p.cashStatus] || STATUS_LABEL[p.cashStatus] || p.cashStatus
      : PAYMENT_STATUS_LABEL[p.status] || p.status || '—';

  return (
    <div className="member-page admin-order-page">
      {back}
      <section className="admin-panel member-head order-head-panel">
        <div>
          <p className="eyebrow">{o.channel}</p>
          <h2>
            <span className="code">{o.code}</span>
          </h2>
          <p className="muted">
            {o.customer.name}
            {o.customer.phone && ` · ${o.customer.phone}`} · {o.customer.address}
          </p>
          <div className="member-tags">
            <span className={`status-pill ${statusTone(o.status)}`}>{statusLabel(o.status)}</span>
            <span className="status-pill">Rider: {o.rider.name || '—'}</span>
            {o.cashier && <span className="status-pill">Kitchen: {o.cashier}</span>}
          </div>
          {o.cancelledReason && (
            <p className="muted small">
              Cancelled{o.cancelledBy ? ` by ${o.cancelledBy}` : ''}: {o.cancelledReason}
            </p>
          )}
        </div>
        <div className="order-head-side">
          <strong className="order-total">{money(o.total)}</strong>
          <div className="print-actions">
            <button className="setup-secondary" onClick={() => void print(o.id, 'receipt')}>
              <Printer /> Receipt
            </button>
            <button className="setup-secondary" onClick={() => void print(o.id, 'kitchen')}>
              <Printer /> Kitchen ticket
            </button>
          </div>
        </div>
      </section>
      {notice && <p className="setup-notice">{notice}</p>}
      {printError && <p className="ops-error">{printError}</p>}

      {o.location && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Delivery pin</h2>
          </div>
          <PinPreview location={o.location} label={`Map of ${o.customer.address}`} />
        </section>
      )}

      <div className="order-page-grid">
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Items</h2>
          </div>
          <div className="table-scroll">
            <table className="data compact-table">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="num">Qty</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {groupBySplit(o.items, o.splits).flatMap((group) => [
                  ...(group.split
                    ? [
                        <tr key={`split-${group.split}`} className="split-row">
                          <td colSpan={2}>
                            <b>{group.split}</b>
                          </td>
                          <td className="num">
                            {money(group.lines.reduce((n, item) => n + item.total, 0))}
                          </td>
                        </tr>,
                      ]
                    : []),
                  ...group.lines.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.name}
                        {(item.accompaniments.length > 0 || item.notes) && (
                          <small>
                            {[
                              sidesLabel(item.accompaniments, item.accompanimentPrices, money),
                              item.notes,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </small>
                        )}
                      </td>
                      <td className="num">{item.qty}</td>
                      <td className="num">{money(item.total)}</td>
                    </tr>
                  )),
                ])}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Food</td>
                  <td className="num">{money(o.subtotal)}</td>
                </tr>
                <tr>
                  <td colSpan={2}>Delivery fee</td>
                  <td className="num">{money(o.deliveryFee)}</td>
                </tr>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td className="num strong">{money(o.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {o.customer.notes && <p className="muted small">Note: {o.customer.notes}</p>}
        </section>

        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Payment</h2>
          </div>
          <dl className="member-lifetime single">
            <div>
              <dt>Method</dt>
              <dd>
                {p.method === 'cash' ? 'Cash' : providerLabel(p.provider) || 'Mobile money'}
                {p.paidAtDoor && ' (at the door)'}
              </dd>
            </div>
            {p.reference && (
              <div>
                <dt>{p.auto ? `${providerLabel(p.provider)} transaction ID` : 'Transaction ID'}</dt>
                <dd>
                  <span className="code">{p.reference}</span>
                  {p.auto && (
                    <small> · confirmed automatically by {providerLabel(p.provider)}</small>
                  )}
                </dd>
              </div>
            )}
            {p.requestReference && (
              <div>
                <dt>Payment request</dt>
                <dd>
                  <span className="code">{p.requestReference}</span>
                  <small>
                    {' '}
                    · sent to {p.requestPhone || 'the customer'}
                    {p.requestStatus && ` · ${p.requestStatus}`}
                    {p.requestError && ` · ${p.requestError}`}
                  </small>
                  <small className="muted block">
                    Search this reference in the {providerLabel(p.provider)} portal to find the
                    request.
                  </small>
                </dd>
              </div>
            )}
            <div>
              <dt>Status</dt>
              <dd>{paymentState}</dd>
            </div>
            {!!p.voucherAmount && (
              <div>
                <dt>Voucher</dt>
                <dd>
                  {money(p.voucherAmount)} paid with the customer&apos;s voucher{' '}
                  <span className="code">{p.voucherCode}</span>
                </dd>
              </div>
            )}
            {(p.vouchers || []).map((v) => (
              <div key={v.id}>
                <dt>Customer&apos;s voucher</dt>
                <dd className={v.status === 'open' ? 'refund-due' : ''}>
                  <span className="code">{v.code}</span> · {money(v.amount)} ·{' '}
                  {v.status === 'open'
                    ? `owed: they can spend it on a new order, or you refund ${money(v.toSend)} (after ${money(v.charges)} charges)`
                    : v.status === 'used'
                      ? `spent${v.usedOn ? ` on ${v.usedOn.code}` : ''}`
                      : `refunded: ${money(v.toSend)} sent, ${money(v.charges)} charges`}
                </dd>
              </div>
            ))}
            {p.refundedAt && (
              <div>
                <dt>Refund</dt>
                <dd>
                  Refunded {new Date(p.refundedAt).toLocaleString()}
                  {p.refundNote && <small className="muted block">{p.refundNote}</small>}
                </dd>
              </div>
            )}
            {p.method === 'cash' && (
              <div>
                <dt>Collected</dt>
                <dd>{money(p.amountCollected)}</dd>
              </div>
            )}
            {p.checkedBy && (
              <div>
                <dt>Checked by</dt>
                <dd>{p.checkedBy}</dd>
              </div>
            )}
            {p.rejectReason && (
              <div>
                <dt>Not received</dt>
                <dd>{p.rejectReason}</dd>
              </div>
            )}
            {o.handovers.map((h) => (
              <div key={h.id}>
                <dt>Handover</dt>
                <dd>
                  {h.code} · {h.status}
                  {h.cashier ? ` · ${h.cashier}` : ''}
                </dd>
              </div>
            ))}
            {o.riderPay && (
              <div>
                <dt>Rider pay</dt>
                <dd>
                  {money(o.riderPay.total)}{' '}
                  {o.riderPay.paid ? '· paid' : o.riderPay.feePaid ? '· fee paid' : '· owed'}
                </dd>
              </div>
            )}
          </dl>
        </section>
        {o.efris && o.efris.status !== 'not_due' && (
          <EfrisPanel
            orderId={o.id}
            view={o.efris}
            cancelled={o.status === 'CANCELLED'}
            onDone={reload}
          />
        )}
      </div>

      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>Change this order</h2>
        </div>
        {choices.length === 0 ? (
          <p className="muted small">
            {o.status === 'CANCELLED'
              ? 'A cancelled order cannot be changed.'
              : 'Nothing to change: the money has been handed over or confirmed, or the rider has been paid for it.'}
          </p>
        ) : (
          <>
            <div className="override-choices" role="radiogroup" aria-label="What to change">
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  role="radio"
                  aria-checked={action === choice.id}
                  className={`override-choice ${action === choice.id ? 'active' : ''} ${
                    choice.danger ? 'danger' : ''
                  }`}
                  onClick={() => {
                    setAction(action === choice.id ? null : choice.id);
                    setActionError('');
                    setNotice('');
                  }}
                >
                  <b>{choice.label}</b>
                  <small>{choice.help}</small>
                </button>
              ))}
            </div>
            {action && (
              <form
                className="override-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {action === 'move' && (
                  <label className="setup-field">
                    New rider
                    <select value={riderId} onChange={(e) => setRiderId(e.target.value)}>
                      <option value="">Choose a rider</option>
                      {riders
                        .filter((r) => r.active && r.id !== o.rider.id)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {(action === 'toMomo' || action === 'deliver') && (
                  <>
                    <label className="setup-field">
                      {action === 'deliver' ? 'Paid by' : 'Mobile money'}
                      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                        {action === 'deliver' && (
                          <option value="">
                            {o.payment.method === 'cash'
                              ? `Cash (${money(o.total)})`
                              : 'As placed (mobile money)'}
                          </option>
                        )}
                        {action === 'toMomo' && <option value="">Choose the network</option>}
                        {(action === 'toMomo' || o.payment.method === 'cash') &&
                          mobileMoney.map((m) => (
                            <option key={m.provider} value={m.provider}>
                              {m.label}
                            </option>
                          ))}
                      </select>
                    </label>
                    {needsMomo && (
                      <label className="setup-field">
                        Transaction ID
                        <input
                          value={reference}
                          onChange={(e) => setReference(e.target.value.toUpperCase())}
                          placeholder="From the payment message"
                          maxLength={40}
                        />
                      </label>
                    )}
                  </>
                )}
                <label className="setup-field wide">
                  Reason (kept in the audit log and sent to the rider)
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                    placeholder="e.g. Rider's phone died at the door"
                  />
                </label>
                {actionError && <p className="ops-error wide">{actionError}</p>}
                <div className="payment-actions wide">
                  <button
                    className={chosen?.danger ? 'danger-solid' : ''}
                    disabled={busy || !ready}
                  >
                    {busy ? 'Saving…' : chosen?.label}
                  </button>
                  <button type="button" className="setup-secondary" onClick={() => setAction(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </section>

      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>History</h2>
        </div>
        <dl className="order-times">
          {TIMES.filter(([key]) => o.times[key]).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{when(o.times[key])}</dd>
            </div>
          ))}
        </dl>
        <ol className="timeline">
          {o.history.map((h) => {
            const changes = changedFields(h.before, h.after).filter((c) => c.key !== 'reason');
            const why = h.after.reason ? String(h.after.reason) : '';
            return (
              <li key={h.id} className={h.action.startsWith('order.override') ? 'override' : ''}>
                <div>
                  <b>{actionLabel(h.action)}</b>
                  <small>
                    {when(h.at)} · {h.actor}
                  </small>
                </div>
                {why && <p className="timeline-reason">“{why}”</p>}
                {h.action.startsWith('order.override') && changes.length > 0 && (
                  <p className="timeline-diff">
                    {changes.map((c) => (
                      <span key={c.key}>
                        {c.key}: {c.before ?? '—'} → {c.after}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

// Tax (EFRIS): the sale's fiscal document, or why it is not issued yet.
function EfrisPanel({
  orderId,
  view,
  cancelled,
  onDone,
}: {
  orderId: string;
  view: NonNullable<OrderPage['efris']>;
  cancelled: boolean;
  onDone: () => void;
}) {
  const { timezone } = useConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('issueEfrisReceipt', { orderId });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel admin-section-panel">
      <div className="panel-title">
        <h2>Tax (EFRIS){view.test ? ' · test' : ''}</h2>
      </div>
      {view.status === 'issued' ? (
        <dl className="member-lifetime single">
          <div>
            <dt>FDN</dt>
            <dd>
              <span className="code">{view.fdn}</span>
            </dd>
          </div>
          <div>
            <dt>Verification code</dt>
            <dd>
              <span className="code">{view.verification}</span>
            </dd>
          </div>
          <div>
            <dt>Issued</dt>
            <dd>
              {formatDate(view.issuedAt, timezone, { dateStyle: 'medium', timeStyle: 'short' })}
            </dd>
          </div>
        </dl>
      ) : (
        <>
          <p className="muted small">
            {view.status === 'failed'
              ? `Not issued yet: ${view.error || 'EFRIS could not be reached'}. RelayEats tries again on its own.`
              : 'Being sent to EFRIS.'}
          </p>
          <button className="setup-secondary" disabled={busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send to EFRIS now'}
          </button>
        </>
      )}
      {cancelled && view.status === 'issued' && (
        <p className="ops-error">
          This order was cancelled after its fiscal receipt was issued. Apply for a credit note for
          FDN {view.fdn} on the EFRIS portal.
        </p>
      )}
      {error && <p className="ops-error">{error}</p>}
    </section>
  );
}
