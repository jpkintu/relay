import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Package,
  Smartphone,
  HandCoins,
  LayoutDashboard,
  LogOut,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import Parse from '../parse';
import { CashierHandovers } from './CashierHandovers';
import { ShiftPanel } from './ShiftPanel';
import { useMoney, useSession } from '../lib/session';
import { personLabel } from '../lib/people';
import { formatDate } from '../lib/format';
import { providerLabel } from './MobileMoney';
import { BrandMark } from './BrandMark';
import { NotificationBell } from './NotificationBell';
import { PushPrompt } from './PushPrompt';
import { Stat } from './reports/common';

type Stage = 'Incoming' | 'Preparing' | 'Ready';
type TicketLine = { text: string; details: string };
type Ticket = {
  id: string;
  code: string;
  rider: string;
  customer: string;
  lines: TicketLine[];
  total: number;
  status: string;
  stage: Stage;
  channel: string;
  payment: string;
  createdAt: Date | null;
  issue: string;
  paymentStatus: string;
  paymentProvider: string;
  paymentReference: string;
};

const stageOf = (status: string): Stage =>
  status === 'PLACED' ? 'Incoming' : status === 'READY' ? 'Ready' : 'Preparing';
const CHANNEL: Record<string, string> = {
  walkin: 'Walk-in',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  other: 'Other',
};
const PAYMENT: Record<string, string> = {
  cash: 'Cash',
  mobile_money: 'Mobile money',
  card: 'Card',
  prepaid: 'Prepaid',
};

async function loadLiveTickets(): Promise<Ticket[]> {
  const query = new Parse.Query('Order');
  query.containedIn('status', ['PLACED', 'ACCEPTED', 'PREPARING', 'READY']);
  query.include('createdBy');
  query.ascending('createdAt');
  query.limit(100);
  const orders = await query.find();
  const itemQuery = new Parse.Query('OrderItem');
  itemQuery.containedIn('order', orders);
  itemQuery.limit(1000);
  const items = orders.length ? await itemQuery.find() : [];
  const lines = new Map<string, TicketLine[]>();
  for (const item of items) {
    const orderId = item.get('order')?.id;
    const line = {
      text: `${item.get('quantity')}× ${item.get('itemNameSnapshot')}`,
      details: [(item.get('accompanimentNames') || []).join(', '), item.get('notes')]
        .filter(Boolean)
        .join(' · '),
    };
    lines.set(orderId, [...(lines.get(orderId) || []), line]);
  }
  return orders.map((order) => ({
    id: order.id!,
    code: order.get('orderCode'),
    rider: personLabel(order.get('createdBy')),
    customer: order.get('customerName'),
    lines: lines.get(order.id!) || [],
    total: order.get('total'),
    status: order.get('status'),
    stage: stageOf(order.get('status')),
    channel: order.get('channel') || '',
    payment: order.get('paymentMethod') || '',
    createdAt: order.createdAt || null,
    issue: order.get('disputeFlag') ? order.get('disputeNote') || 'Problem reported' : '',
    paymentStatus: order.get('paymentStatus') || '',
    paymentProvider: order.get('paymentProvider') || '',
    paymentReference: order.get('paymentReference') || '',
  }));
}

const minutesSince = (date: Date | null) =>
  date ? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000)) : 0;

async function countPendingPayments(): Promise<number> {
  const query = new Parse.Query('Order');
  query.equalTo('paymentStatus', 'PENDING_VERIFICATION');
  return query.count();
}

async function countPendingHandovers(): Promise<number> {
  const query = new Parse.Query('CashHandover');
  query.equalTo('status', 'pending');
  return query.count();
}

export function CashierWorkspace() {
  const { preview, profile, logout } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [pendingHandovers, setPendingHandovers] = useState(0);
  const [pendingPayments, setPendingPayments] = useState(0);
  // Cashiers must start a shift (counting the till) before using the board.
  // Admins are not till operators and skip this.
  const needsShift = !preview && profile?.role === 'cashier';
  const [onShift, setOnShift] = useState<boolean | null>(needsShift ? null : true);
  const checkShift = useCallback(async () => {
    if (!needsShift) return setOnShift(true);
    try {
      setOnShift(!!(await Parse.Cloud.run('getMyShift')).shift);
    } catch {
      setOnShift(false);
    }
  }, [needsShift]);
  useEffect(() => {
    void checkShift();
  }, [checkShift]);

  useEffect(() => {
    if (preview) return;
    const refresh = () => {
      countPendingHandovers()
        .then(setPendingHandovers)
        .catch(() => undefined);
      countPendingPayments()
        .then(setPendingPayments)
        .catch(() => undefined);
    };
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [preview, pathname]);

  const tab = pathname.startsWith('/cashier/handovers')
    ? 'handovers'
    : pathname.startsWith('/cashier/shift')
      ? 'shift'
      : pathname.startsWith('/cashier/stock')
        ? 'stock'
        : pathname.startsWith('/cashier/payments')
          ? 'payments'
          : 'orders';
  return (
    <main className="ops-shell">
      <header className="ops-header">
        <BrandMark />
        <nav hidden={onShift === false}>
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => navigate('/cashier')}>
            <UtensilsCrossed />
            Kitchen board
          </button>
          <button
            className={tab === 'handovers' ? 'active' : ''}
            onClick={() => navigate('/cashier/handovers')}
          >
            <HandCoins />
            Cash handovers {pendingHandovers > 0 && <b>{pendingHandovers}</b>}
          </button>
          <button
            className={tab === 'payments' ? 'active' : ''}
            onClick={() => navigate('/cashier/payments')}
          >
            <Smartphone />
            Mobile money {pendingPayments > 0 && <b>{pendingPayments}</b>}
          </button>
          <button
            className={tab === 'stock' ? 'active' : ''}
            onClick={() => navigate('/cashier/stock')}
          >
            <Package />
            Stock
          </button>
          <button
            className={tab === 'shift' ? 'active' : ''}
            onClick={() => navigate('/cashier/shift')}
          >
            <Clock3 />
            Shift
          </button>
          {profile?.role === 'admin' && (
            <button onClick={() => navigate('/admin')}>
              <LayoutDashboard />
              Admin
            </button>
          )}
        </nav>
        <div className="shift-live">
          {profile ? `${profile.code ? `${profile.code} · ` : ''}${profile.name}` : 'Cashier'}
        </div>
        <NotificationBell />
        <button className="icon-button" onClick={() => void logout()} aria-label="Log out">
          <LogOut />
        </button>
      </header>
      {!preview && <PushPrompt card />}
      {onShift === null ? (
        <div className="ops-content">
          <p className="muted">Checking your shift…</p>
        </div>
      ) : !onShift ? (
        <div className="ops-content shift-gate">
          <p className="muted">
            Count the cash in the till and enter it to open your shift. The kitchen board, cash
            handovers, mobile money and stock open once your shift has started, and your till is
            reconciled against this count when you end it.
          </p>
          <ShiftPanel kind="cashier" preview={preview} onChanged={() => void checkShift()} />
        </div>
      ) : (
        <Routes>
          <Route index element={<KitchenBoard />} />
          <Route path="handovers" element={<CashierHandovers preview={preview} />} />
          <Route path="stock" element={<StockPanel />} />
          <Route path="payments" element={<MobileMoneyLedger />} />
          <Route
            path="shift"
            element={
              <div className="ops-content">
                <ShiftPanel kind="cashier" preview={preview} onChanged={() => void checkShift()} />
              </div>
            }
          />
          <Route path="*" element={<Navigate to="/cashier" replace />} />
        </Routes>
      )}
    </main>
  );
}

function KitchenBoard() {
  const { preview, config } = useSession();
  const money = useMoney();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState<{
    id: string;
    action: 'reject' | 'cancel' | 'payment';
  } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      if (preview) {
        const rows: {
          id: string;
          code: string;
          rider: string;
          customer: string;
          items: string;
          total: number;
          status: string;
        }[] = await Parse.Cloud.run('getPreviewOrders');
        setTickets(
          rows.map((row) => ({
            ...row,
            lines: [{ text: row.items, details: '' }],
            stage: stageOf(row.status),
            channel: '',
            payment: '',
            createdAt: null,
            issue: '',
            paymentStatus: '',
            paymentProvider: '',
            paymentReference: '',
          })),
        );
      } else {
        setTickets(await loadLiveTickets());
      }
      setError('');
    } catch {
      setError('Could not refresh the live board.');
    }
  }, [preview]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  const checkPayment = async (ticket: Ticket, received: boolean, why = '') => {
    try {
      await Parse.Cloud.run('verifyPayment', { orderId: ticket.id, received, reason: why });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the payment');
      return false;
    }
    await load();
    return true;
  };

  const run = async (ticket: Ticket, action: string, extra: Record<string, unknown> = {}) => {
    try {
      const fn = preview ? 'transitionPreviewOrder' : 'transitionOrder';
      if (preview && ticket.status === 'ACCEPTED' && action === 'ready')
        await Parse.Cloud.run(fn, { orderId: ticket.id, action: 'prepare' });
      await Parse.Cloud.run(fn, { orderId: ticket.id, action, ...extra });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      return false;
    }
    await load();
    return true;
  };

  return (
    <div className="ops-content">
      {error && <div className="ops-error">{error}</div>}
      <div className="ops-title">
        <div>
          <h1>Kitchen board</h1>
        </div>
        <span>
          <Clock3 /> Refreshes every 10 seconds
        </span>
      </div>
      <div className="board-grid">
        {(['Incoming', 'Preparing', 'Ready'] as const).map((stage) => (
          <section className="board-column" key={stage}>
            <header>
              <span className={`board-dot ${stage.toLowerCase()}`} />
              <h2>{stage}</h2>
              <b>{tickets.filter((t) => t.stage === stage).length}</b>
            </header>
            {tickets
              .filter((t) => t.stage === stage)
              .map((ticket) => {
                const age = minutesSince(ticket.createdAt);
                const isClosing = closing?.id === ticket.id;
                return (
                  <article className="ticket" key={ticket.id}>
                    <div className="ticket-top">
                      <b>{ticket.code}</b>
                      <span>{money(ticket.total)}</span>
                    </div>
                    <div className="ticket-meta">
                      {ticket.createdAt && (
                        <span className={age >= 20 ? 'late' : ''}>{age} min</span>
                      )}
                      {ticket.channel && <span>{CHANNEL[ticket.channel] || ticket.channel}</span>}
                      {ticket.payment && <span>{PAYMENT[ticket.payment] || ticket.payment}</span>}
                    </div>
                    <h3>{ticket.customer}</h3>
                    <ul className="ticket-lines">
                      {ticket.lines.map((line, index) => (
                        <li key={index}>
                          {line.text}
                          {line.details && <small>{line.details}</small>}
                        </li>
                      ))}
                    </ul>
                    {ticket.issue && <p className="ticket-issue">⚠ {ticket.issue}</p>}
                    {ticket.paymentStatus && (
                      <p className={`ticket-payment payment-${ticket.paymentStatus.toLowerCase()}`}>
                        {providerLabel(ticket.paymentProvider)} · {ticket.paymentReference} ·{' '}
                        {ticket.paymentStatus === 'VERIFIED'
                          ? 'paid ✓'
                          : ticket.paymentStatus === 'REJECTED'
                            ? 'not received: waiting for rider'
                            : 'check payment'}
                      </p>
                    )}
                    <small>{ticket.rider}</small>
                    {isClosing ? (
                      <div className="ticket-close">
                        <input
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder={
                            closing.action === 'reject'
                              ? 'Why reject? e.g. out of chicken'
                              : closing.action === 'payment'
                                ? 'Why not? e.g. not on the MTN statement'
                                : 'Why cancel?'
                          }
                        />
                        <div className="ticket-actions">
                          <button onClick={() => setClosing(null)}>Back</button>
                          <button
                            className="reject"
                            disabled={reason.trim().length < 3}
                            onClick={async () => {
                              const done =
                                closing.action === 'payment'
                                  ? await checkPayment(ticket, false, reason)
                                  : await run(ticket, closing.action, { reason });
                              if (done) {
                                setClosing(null);
                                setReason('');
                              }
                            }}
                          >
                            <X />
                            {closing.action === 'reject'
                              ? 'Reject order'
                              : closing.action === 'payment'
                                ? 'Payment not received'
                                : 'Cancel order'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="ticket-actions">
                        {stage === 'Incoming' &&
                          ticket.paymentStatus === 'PENDING_VERIFICATION' && (
                            <>
                              <button
                                className="reject"
                                onClick={() => {
                                  setClosing({ id: ticket.id, action: 'payment' });
                                  setReason('');
                                }}
                              >
                                <X />
                                Not received
                              </button>
                              <button onClick={() => void checkPayment(ticket, true)}>
                                <Check />
                                Payment received
                              </button>
                            </>
                          )}
                        {stage === 'Incoming' && ticket.paymentStatus === 'REJECTED' && (
                          <button
                            className="reject"
                            onClick={() => {
                              setClosing({ id: ticket.id, action: 'reject' });
                              setReason('');
                            }}
                          >
                            <X />
                            Reject order
                          </button>
                        )}
                        {stage === 'Incoming' &&
                          !['PENDING_VERIFICATION', 'REJECTED'].includes(ticket.paymentStatus) && (
                            <>
                              <button
                                className="reject"
                                disabled={preview}
                                onClick={() => {
                                  setClosing({ id: ticket.id, action: 'reject' });
                                  setReason('');
                                }}
                              >
                                <X />
                                Reject
                              </button>
                              <button onClick={() => void run(ticket, 'accept')}>
                                <Check />
                                Accept
                              </button>
                            </>
                          )}
                        {stage === 'Preparing' && (
                          <button onClick={() => void run(ticket, 'ready')}>
                            Mark ready <ChevronRight />
                          </button>
                        )}
                        {stage === 'Ready' && (
                          <button onClick={() => void run(ticket, 'pickup')}>
                            <ClipboardCheck />
                            Hand to rider
                          </button>
                        )}
                      </div>
                    )}
                    {stage !== 'Incoming' && !isClosing && !preview && (
                      <button
                        className="link-button"
                        onClick={() => {
                          setClosing({ id: ticket.id, action: 'cancel' });
                          setReason('');
                        }}
                      >
                        Cancel order
                      </button>
                    )}
                  </article>
                );
              })}
          </section>
        ))}
      </div>
      {config.requireCashierConfirmForPickup && (
        <p className="muted">Riders cannot mark pickup themselves: use “Hand to rider”.</p>
      )}
    </div>
  );
}

// Day-to-day availability: mark dishes and accompaniments sold out or back.
function StockPanel() {
  const { preview } = useSession();
  const [stock, setStock] = useState<{
    items: { id: string; title: string; category: string; available: boolean }[];
    accompaniments: { id: string; title: string; available: boolean }[];
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (preview) return;
    try {
      setStock(await Parse.Cloud.run('getStock'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load stock');
    }
  }, [preview]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (type: 'menuItem' | 'accompaniment', id: string, available: boolean) => {
    setBusy(id);
    try {
      await Parse.Cloud.run('setAvailability', { type, id, available });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy('');
    }
  };

  const row = (
    type: 'menuItem' | 'accompaniment',
    entry: { id: string; title: string; available: boolean },
    detail?: string,
  ) => (
    <div className={entry.available ? 'stock-row' : 'stock-row sold-out'} key={entry.id}>
      <div>
        <b>{entry.title}</b>
        {detail && <small>{detail}</small>}
      </div>
      <span>{entry.available ? 'Available' : 'Sold out'}</span>
      <button
        disabled={busy === entry.id}
        onClick={() => void toggle(type, entry.id, !entry.available)}
      >
        {entry.available ? 'Mark sold out' : 'Back in stock'}
      </button>
    </div>
  );

  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <h1>Stock</h1>
        </div>
        <span>Sold-out items disappear from riders’ menus straight away.</span>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {preview && <p className="setup-notice">Stock control needs a signed-in cashier.</p>}
      {stock && (
        <div className="stock-grid">
          <section className="admin-panel">
            <h2>Accompaniments</h2>
            {stock.accompaniments.map((a) => row('accompaniment', a))}
            {!stock.accompaniments.length && (
              <p className="empty-orders">No accompaniments set up yet.</p>
            )}
          </section>
          <section className="admin-panel">
            <h2>Dishes</h2>
            {stock.items.map((i) => row('menuItem', i, i.category))}
          </section>
        </div>
      )}
    </div>
  );
}

type PaymentRow = {
  id: string;
  code: string;
  customer: string;
  rider: string;
  provider: string;
  reference: string;
  amount: number;
  paymentStatus: string;
  orderStatus: string;
  createdAt: string;
  checkedAt: string | null;
  checkedBy: string;
  rejectReason: string;
};
type Ledger = {
  pending: PaymentRow[];
  verified: PaymentRow[];
  rejected: PaymentRow[];
  totals: { provider: string; label: string; code: string; count: number; amount: number }[];
};

// Mobile money reconciliation: confirm payments against the Airtel/MTN
// merchant accounts, and compare today's totals with the merchant statements.
function MobileMoneyLedger() {
  const { preview, config } = useSession();
  const money = useMoney();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (preview) return;
    try {
      setLedger(await Parse.Cloud.run('getMobileMoneyLedger'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payments');
    }
  }, [preview]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  const check = async (row: PaymentRow, received: boolean) => {
    setBusy(row.id);
    try {
      await Parse.Cloud.run('verifyPayment', { orderId: row.id, received, reason });
      setRejecting(null);
      setReason('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the payment');
    } finally {
      setBusy('');
    }
  };

  const time = (row: PaymentRow) =>
    formatDate(row.checkedAt || row.createdAt, config.timezone, { timeStyle: 'short' });
  const transaction = (row: PaymentRow) => (
    <td data-label="Transaction">
      <b>{providerLabel(row.provider)}</b>
      <span className="code">{row.reference}</span>
    </td>
  );
  const orderCell = (row: PaymentRow) => (
    <td data-label="Order">
      <span className="code">{row.code}</span>
      <small>{row.customer}</small>
    </td>
  );
  const matches = (row: PaymentRow) =>
    `${row.reference} ${row.code} ${row.customer} ${row.rider}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  const verified = (ledger?.verified ?? []).filter(matches);

  return (
    <div className="ops-content">
      <div className="ops-title">
        <div>
          <h1>Mobile money</h1>
        </div>
        <span>Check each transaction ID on the merchant account before confirming.</span>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {preview && <p className="setup-notice">Mobile money needs a signed-in cashier.</p>}
      {ledger && (
        <>
          <div className="stat-grid">
            <Stat
              label="Waiting for a check"
              value={money(ledger.pending.reduce((n, r) => n + r.amount, 0))}
              note={`${ledger.pending.length} payment${ledger.pending.length === 1 ? '' : 's'}`}
            />
            {ledger.totals.map((t) => (
              <Stat
                key={t.provider}
                label={`${t.label} · ${t.code}`}
                value={money(t.amount)}
                note={`${t.count} confirmed today`}
              />
            ))}
            {!ledger.totals.length && (
              <Stat
                label="No merchant codes"
                value="—"
                note="The owner adds Airtel/MTN merchant codes in Settings."
              />
            )}
            {ledger.rejected.length > 0 && (
              <Stat
                label="Not received today"
                value={ledger.rejected.length}
                note={money(ledger.rejected.reduce((n, r) => n + r.amount, 0))}
              />
            )}
          </div>

          <section className="admin-panel admin-section-panel">
            <div className="panel-title">
              <h2>
                Waiting for a check <small>({ledger.pending.length})</small>
              </h2>
            </div>
            {ledger.pending.length > 0 ? (
              <div className="table-scroll">
                <table className="data stack-on-phone">
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th>Order</th>
                      <th>Rider</th>
                      <th>Sent</th>
                      <th className="num">Amount</th>
                      <th>Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.pending.map((row) => (
                      <tr key={row.id}>
                        {transaction(row)}
                        {orderCell(row)}
                        <td data-label="Rider">{row.rider}</td>
                        <td data-label="Sent" className="nowrap">
                          {time(row)}
                        </td>
                        <td data-label="Amount" className="num strong">
                          {money(row.amount)}
                        </td>
                        <td data-label="Check" className="actions-cell">
                          {rejecting === row.id ? (
                            <div className="payment-actions">
                              <input
                                autoFocus
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="Why not? e.g. not on statement"
                              />
                              <button onClick={() => setRejecting(null)}>Back</button>
                              <button
                                className="reject"
                                disabled={busy === row.id || reason.trim().length < 3}
                                onClick={() => void check(row, false)}
                              >
                                Not received
                              </button>
                            </div>
                          ) : (
                            <div className="payment-actions">
                              <button
                                className="reject"
                                disabled={busy === row.id}
                                onClick={() => {
                                  setRejecting(row.id);
                                  setReason('');
                                }}
                              >
                                Not received
                              </button>
                              <button
                                disabled={busy === row.id}
                                onClick={() => void check(row, true)}
                              >
                                <Check /> Received
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-orders">Nothing waiting.</p>
            )}
          </section>

          <section className="admin-panel admin-section-panel">
            <div className="panel-title">
              <h2>
                Confirmed today <small>({ledger.verified.length})</small>
              </h2>
              <input
                className="admin-filter compact"
                placeholder="Search reference, order or rider"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search confirmed payments"
              />
            </div>
            {verified.length > 0 ? (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th>Order</th>
                      <th>Rider</th>
                      <th>Confirmed</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verified.map((row) => (
                      <tr key={row.id}>
                        {transaction(row)}
                        {orderCell(row)}
                        <td>{row.rider}</td>
                        <td className="nowrap">
                          {time(row)}
                          {row.checkedBy && <small>{row.checkedBy}</small>}
                        </td>
                        <td className="num strong">{money(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        {verified.length} payment{verified.length === 1 ? '' : 's'}
                      </td>
                      <td className="num">{money(verified.reduce((n, r) => n + r.amount, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="empty-orders">
                {ledger.verified.length ? 'No match.' : 'None yet today.'}
              </p>
            )}
          </section>

          {ledger.rejected.length > 0 && (
            <section className="admin-panel admin-section-panel">
              <div className="panel-title">
                <h2>
                  Not received today <small>({ledger.rejected.length})</small>
                </h2>
              </div>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th>Order</th>
                      <th>Rider</th>
                      <th>Reason</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.rejected.map((row) => (
                      <tr key={row.id}>
                        {transaction(row)}
                        {orderCell(row)}
                        <td>{row.rider}</td>
                        <td>
                          {row.rejectReason}
                          <small>
                            {time(row)}
                            {row.checkedBy && ` · ${row.checkedBy}`}
                          </small>
                        </td>
                        <td className="num">{money(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
