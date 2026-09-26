import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, MapPin, Phone } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import {
  MobileMoneyPanel,
  PAYMENT_STATUS_LABEL,
  providerLabel,
  referenceProblem,
} from './MobileMoney';
import { NotificationBell } from './NotificationBell';
import { statusLabel, statusTone } from '../lib/labels';

type Line = { id: string; title: string; quantity: number; total: number; details: string };
type Detail = {
  id: string;
  code: string;
  status: string;
  channel: string;
  customerName: string;
  customerPhone: string;
  address: string;
  addressNotes: string;
  subtotal: number;
  fee: number;
  total: number;
  paymentMethod: string;
  amountToCollect: number;
  amountCollected: number;
  shortfallNote: string;
  cashStatus: string;
  commission: number;
  cancelledReason: string;
  disputeFlag: boolean;
  disputeNote: string;
  paymentProvider: string;
  paymentReference: string;
  paymentStatus: string;
  paymentRejectReason: string;
  createdAt: Date;
  lines: Line[];
};

const PAYMENTS = [
  ['cash', 'Cash'],
  ['mobile_money', 'Mobile money'],
] as const;
const PAYMENT_LABEL: Record<string, string> = {
  ...Object.fromEntries(PAYMENTS),
  card: 'Card',
  prepaid: 'Prepaid',
};
const CHANNEL_LABEL: Record<string, string> = {
  walkin: 'Walk-in',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  other: 'Other',
};

async function loadDetail(orderId: string): Promise<Detail> {
  const order = await new Parse.Query('Order').get(orderId);
  const items = await new Parse.Query('OrderItem').equalTo('order', order).limit(100).find();
  return {
    id: order.id!,
    code: order.get('orderCode'),
    status: order.get('status'),
    channel: order.get('channel'),
    customerName: order.get('customerName'),
    customerPhone: order.get('customerPhone') || '',
    address: order.get('deliveryAddress'),
    addressNotes: order.get('deliveryNotes') || '',
    subtotal: order.get('subtotal'),
    fee: order.get('deliveryFee'),
    total: order.get('total'),
    paymentMethod: order.get('paymentMethod'),
    amountToCollect: order.get('amountToCollect') ?? order.get('total'),
    amountCollected: order.get('amountCollected') || 0,
    shortfallNote: order.get('shortfallNote') || '',
    cashStatus: order.get('cashStatus'),
    commission: order.get('commissionAmount') || 0,
    cancelledReason: order.get('cancelledReason') || '',
    disputeFlag: !!order.get('disputeFlag'),
    disputeNote: order.get('disputeNote') || '',
    paymentProvider: order.get('paymentProvider') || '',
    paymentReference: order.get('paymentReference') || '',
    paymentStatus: order.get('paymentStatus') || '',
    paymentRejectReason: order.get('paymentRejectReason') || '',
    createdAt: order.createdAt!,
    lines: items.map((item) => ({
      id: item.id!,
      title: item.get('itemNameSnapshot'),
      quantity: item.get('quantity'),
      total: item.get('lineTotal'),
      details: [(item.get('accompanimentNames') || []).join(', '), item.get('notes')]
        .filter(Boolean)
        .join(' · '),
    })),
  };
}

export function OrderDetail({
  orderId,
  onBack,
  onChanged,
}: {
  orderId: string;
  onBack: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { timezone, requireCashierConfirmForPickup } = useConfig();
  const { preview } = useSession();
  const money = useMoney();
  const [order, setOrder] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [issue, setIssue] = useState('');
  const [showIssue, setShowIssue] = useState(false);
  const [payment, setPayment] = useState('');
  const [collected, setCollected] = useState('');
  const [shortNote, setShortNote] = useState('');
  const [provider, setProvider] = useState('');
  const [reference, setReference] = useState('');

  const load = useCallback(async () => {
    try {
      setOrder(await loadDetail(orderId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the order');
    }
  }, [orderId]);
  useEffect(() => {
    if (preview) return;
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load, preview]);

  const act = async (fn: string, params: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run(fn, { orderId, ...params });
      await load();
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const method = payment || order?.paymentMethod || 'cash';
  const isCash = method === 'cash';
  const amount = collected === '' ? (order?.amountToCollect ?? 0) : Number(collected);
  const short = !!order && isCash && amount < order.total;
  const paidByMomo = order?.paymentMethod === 'mobile_money';
  const switchingToMomo = !!order && !paidByMomo && method === 'mobile_money';

  return (
    <main className="rider-shell">
      <header className="order-head">
        <button className="icon-button" onClick={onBack} aria-label="Back">
          <ChevronRight style={{ transform: 'rotate(180deg)' }} />
        </button>
        <div>
          <p className="eyebrow">{order ? formatDate(order.createdAt, timezone) : 'Order'}</p>
          <h2>{order?.code || 'Order'}</h2>
        </div>
        {order && (
          <span className={`status-pill ${statusTone(order.status)}`}>
            {statusLabel(order.status)}
          </span>
        )}
        <NotificationBell />
      </header>
      <div className="subpage-content order-detail">
        {preview && <p className="info-card">Order details need a signed-in rider.</p>}
        {error && <p className="ops-error">{error}</p>}
        {order && (
          <>
            <section className="detail-card">
              <p className="eyebrow">Customer · {CHANNEL_LABEL[order.channel] || order.channel}</p>
              <h3>{order.customerName}</h3>
              {order.customerPhone && (
                <a className="detail-link" href={`tel:${order.customerPhone}`}>
                  <Phone size={16} /> {order.customerPhone}
                </a>
              )}
              <a
                className="detail-link"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}`}
                target="_blank"
                rel="noreferrer"
              >
                <MapPin size={16} /> {order.address}
              </a>
              {order.addressNotes && <p className="muted">{order.addressNotes}</p>}
            </section>

            <section className="detail-card">
              <p className="eyebrow">Items</p>
              {order.lines.map((line) => (
                <div className="cart-line" key={line.id}>
                  <div>
                    <b>
                      {line.quantity}× {line.title}
                    </b>
                    {line.details && <small>{line.details}</small>}
                  </div>
                  <span>{money(line.total)}</span>
                </div>
              ))}
              <div className="bill">
                <div>
                  <span>Subtotal</span>
                  <b>{money(order.subtotal)}</b>
                </div>
                <div>
                  <span>Delivery fee</span>
                  <b>{money(order.fee)}</b>
                </div>
                <div className="bill-total">
                  <span>Total · {PAYMENT_LABEL[order.paymentMethod] || order.paymentMethod}</span>
                  <b>{money(order.total)}</b>
                </div>
                {order.shortfallNote && (
                  <p className="muted full-row">Short payment: {order.shortfallNote}</p>
                )}
              </div>
            </section>

            {order.status === 'CANCELLED' && (
              <p className="info-card">Cancelled: {order.cancelledReason || 'no reason given'}</p>
            )}
            {order.paymentStatus && (
              <section
                className={`detail-card payment-card payment-${order.paymentStatus.toLowerCase()}`}
              >
                <p className="eyebrow">
                  {providerLabel(order.paymentProvider)} · Transaction {order.paymentReference}
                </p>
                <h3>{PAYMENT_STATUS_LABEL[order.paymentStatus] || order.paymentStatus}</h3>
                {order.paymentStatus === 'PENDING_VERIFICATION' && (
                  <p className="muted">
                    The kitchen starts once the cashier finds this payment on the merchant account.
                  </p>
                )}
                {order.paymentStatus === 'REJECTED' && (
                  <>
                    <p className="form-error">Cashier: {order.paymentRejectReason}</p>
                    {order.status !== 'CANCELLED' && (
                      <>
                        <MobileMoneyPanel
                          provider={provider || order.paymentProvider}
                          reference={reference}
                          amount={order.total}
                          customerPhone={order.customerPhone}
                          onProvider={setProvider}
                          onReference={setReference}
                        />
                        <button
                          className="primary-button wide"
                          disabled={busy || !!referenceProblem(reference)}
                          onClick={async () => {
                            if (
                              await act('resubmitPayment', {
                                provider: provider || order.paymentProvider,
                                reference,
                              })
                            )
                              setReference('');
                          }}
                        >
                          Send corrected transaction ID
                        </button>
                      </>
                    )}
                  </>
                )}
              </section>
            )}
            {order.disputeFlag && (
              <p className="ops-error">Problem reported: {order.disputeNote}</p>
            )}

            {order.status === 'PLACED' && (
              <section className="detail-card">
                <p>Waiting for the kitchen to accept.</p>
                <label className="setup-field">
                  Cancel reason
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. customer changed their mind"
                  />
                </label>
                <button
                  className="setup-secondary danger"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void act('transitionOrder', { action: 'cancel', reason })}
                >
                  Cancel order
                </button>
              </section>
            )}
            {['ACCEPTED', 'PREPARING'].includes(order.status) && (
              <p className="info-card">
                The kitchen is preparing this order. To cancel now, ask the cashier.
              </p>
            )}
            {order.status === 'READY' &&
              (requireCashierConfirmForPickup ? (
                <p className="info-card">Ready. Collect the bag; the cashier confirms pickup.</p>
              ) : (
                <button
                  className="primary-button wide"
                  disabled={busy}
                  onClick={() => void act('transitionOrder', { action: 'pickup' })}
                >
                  Confirm pickup
                </button>
              ))}
            {order.status === 'PICKED_UP' && (
              <section className="detail-card">
                <p className="eyebrow">Confirm delivery</p>
                {paidByMomo ? (
                  <p className="muted">
                    Paid by {providerLabel(order.paymentProvider)}. Nothing to collect.
                  </p>
                ) : (
                  <div className="channel-row">
                    <span>Paid by</span>
                    {PAYMENTS.map(([value, label]) => (
                      <button
                        key={value}
                        className={method === value ? 'active' : ''}
                        onClick={() => setPayment(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {switchingToMomo && (
                  <MobileMoneyPanel
                    provider={provider}
                    reference={reference}
                    amount={order.total}
                    customerPhone={order.customerPhone}
                    onProvider={setProvider}
                    onReference={setReference}
                  />
                )}
                {isCash && (
                  <label className="setup-field">
                    Cash collected
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={collected === '' ? order.amountToCollect : collected}
                      onChange={(e) => setCollected(e.target.value)}
                    />
                  </label>
                )}
                {short && (
                  <label className="setup-field">
                    Why is it less than {money(order.total)}?
                    <input
                      value={shortNote}
                      onChange={(e) => setShortNote(e.target.value)}
                      placeholder={order.shortfallNote || 'Required for short payments'}
                    />
                  </label>
                )}
                <button
                  className="primary-button wide"
                  disabled={
                    busy ||
                    (isCash && !Number.isFinite(amount)) ||
                    (switchingToMomo && (!provider || !!referenceProblem(reference))) ||
                    (short && !order.shortfallNote && shortNote.trim().length < 5)
                  }
                  onClick={() =>
                    void act('transitionOrder', {
                      action: 'deliver',
                      paymentMethod: method,
                      amountCollected: isCash ? amount : 0,
                      shortfallNote: shortNote,
                      ...(switchingToMomo && {
                        paymentProvider: provider,
                        paymentReference: reference,
                      }),
                    })
                  }
                >
                  Confirm delivery
                </button>
              </section>
            )}
            {order.status === 'DELIVERED' && (
              <p className="info-card">
                Delivered. You earned {money(order.commission)}.
                {order.paymentMethod === 'cash' &&
                  ` Cash ${money(order.amountCollected)} · ${order.cashStatus.replace('_', ' ').toLowerCase()}.`}
              </p>
            )}

            {order.status !== 'CANCELLED' && !order.disputeFlag && (
              <section className="detail-card">
                {showIssue ? (
                  <>
                    <label className="setup-field">
                      What went wrong?
                      <input
                        value={issue}
                        onChange={(e) => setIssue(e.target.value)}
                        placeholder="e.g. soup spilled, customer says item missing"
                      />
                    </label>
                    <button
                      className="setup-secondary"
                      disabled={busy || issue.trim().length < 5}
                      onClick={async () => {
                        if (await act('flagOrderIssue', { note: issue })) setShowIssue(false);
                      }}
                    >
                      Report problem
                    </button>
                  </>
                ) : (
                  <button className="link-button" onClick={() => setShowIssue(true)}>
                    Report a problem with this order
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {order &&
        order.paymentMethod === 'cash' &&
        !['DELIVERED', 'CANCELLED'].includes(order.status) && (
          <div className="collect-bar">
            Collect <b>{money(order.amountToCollect)}</b> in cash
          </div>
        )}
    </main>
  );
}
