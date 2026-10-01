import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive,
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
  Banknote,
  Plus,
} from 'lucide-react';
import Parse from '../parse';
import { groupBySplit } from '../lib/cart';
import { CashierHandovers } from './CashierHandovers';
import { CashierPayouts } from './CashierPayouts';
import { CashierDrawer } from './CashierDrawer';
import { openDrawer } from '../lib/drawer';
import { CashierProfile } from './Profile';
import { ShiftPanel } from './ShiftPanel';
import { useMoney, useSession } from '../lib/session';
import { personLabel } from '../lib/people';
import { formatDate } from '../lib/format';
import { inBranch } from '../lib/branch';
import {
  PaymentRequestStatus,
  payerPhoneProblem,
  providerLabel,
  referenceProblem,
} from './MobileMoney';
import { BrandMark } from './BrandMark';
import { NotificationBell } from './NotificationBell';
import { PushPrompt } from './PushPrompt';
import { InstallPrompt } from './InstallPrompt';
import { BranchSelect, Stat, useBranchOptions } from './reports/common';
import { useLiveRefresh } from '../lib/live';
import { NewOrder } from './NewOrder';
import { usePrint } from '../lib/print';

type Stage = 'Incoming' | 'Preparing' | 'Ready';
// `split`: split orders only, the guest or portion the line is for.
type TicketLine = { text: string; details: string; split?: string };
type Ticket = {
  id: string;
  // Longest prep time of its dishes (0 = not set: late after 20 min).
  prepMinutes?: number;
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
  // The cashier handling this order (empty until someone takes it).
  holderId: string;
  holderName: string;
  // delivery (default), eat_in or pickup; source 'counter' when a cashier
  // took the order.
  orderType: string;
  fromCounter: boolean;
  riderId: string;
  billOpen: boolean;
  table: string;
};

const TYPE_LABEL: Record<string, string> = { eat_in: 'Eat in', pickup: 'Pick up' };

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

// A cashier's board, payments and handovers are their branch's (the owner
// sees every branch).
async function loadLiveTickets(branchId?: string | null): Promise<Ticket[]> {
  const query = inBranch(new Parse.Query('Order'), branchId);
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
      split: item.get('split') || '',
    };
    lines.set(orderId, [...(lines.get(orderId) || []), line]);
  }
  // Split orders: lines in the order the splits were entered.
  for (const order of orders) {
    const splits: string[] = order.get('splits') || [];
    const own = lines.get(order.id!);
    if (splits.length && own)
      lines.set(
        order.id!,
        groupBySplit(own, splits).flatMap((group) => group.lines),
      );
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
    holderId: order.get('cashier')?.id || '',
    holderName: order.get('cashierName') || '',
    orderType: order.get('orderType') || 'delivery',
    fromCounter: order.get('source') === 'counter',
    riderId: order.get('createdBy')?.id || '',
    billOpen: order.get('billOpen') === true,
    table: order.get('tableLabel') || '',
    prepMinutes: Number(order.get('prepMinutes') || 0),
  }));
}

const minutesSince = (date: Date | null) =>
  date ? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000)) : 0;

async function countPendingPayments(branchId?: string | null): Promise<number> {
  const query = inBranch(new Parse.Query('Order'), branchId);
  query.equalTo('paymentStatus', 'PENDING_VERIFICATION');
  return query.count();
}

async function countPendingHandovers(branchId?: string | null): Promise<number> {
  const query = inBranch(new Parse.Query('CashHandover'), branchId);
  query.equalTo('status', 'pending');
  return query.count();
}

export function CashierWorkspace() {
  const { preview, profile, logout, config } = useSession();
  const myBranch = profile?.role === 'cashier' ? profile.branch?.id : null;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [pendingHandovers, setPendingHandovers] = useState(0);
  const [pendingPayments, setPendingPayments] = useState(0);
  // Bumped by live updates (and the fallback poll) to recount the badges.
  const [liveTick, setLiveTick] = useState(0);
  useLiveRefresh(['Order', 'CashHandover'], () => setLiveTick((n) => n + 1), {
    enabled: !preview,
  });
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
      countPendingHandovers(myBranch)
        .then(setPendingHandovers)
        .catch(() => undefined);
      countPendingPayments(myBranch)
        .then(setPendingPayments)
        .catch(() => undefined);
    };
    void refresh();
  }, [preview, pathname, liveTick, myBranch]);

  const modules = profile?.config.modules;
  const takesOrders = !!(modules?.callIn || modules?.counter);
  const tab = pathname.startsWith('/cashier/new')
    ? 'new'
    : pathname.startsWith('/cashier/handovers')
      ? 'handovers'
      : pathname.startsWith('/cashier/shift')
        ? 'shift'
        : pathname.startsWith('/cashier/stock')
          ? 'stock'
          : pathname.startsWith('/cashier/payments')
            ? 'payments'
            : pathname.startsWith('/cashier/payouts')
              ? 'payouts'
              : pathname.startsWith('/cashier/drawer')
                ? 'drawer'
                : 'orders';
  return (
    <main className="ops-shell">
      <header className="ops-header">
        <BrandMark logo={profile?.config.restaurantLogo} name={profile?.config.restaurantName} />
        <nav hidden={onShift === false}>
          <button
            className={tab === 'orders' ? 'active' : ''}
            onClick={() => navigate('/cashier')}
            title="Kitchen board"
          >
            <UtensilsCrossed />
            Kitchen board
          </button>
          {takesOrders && (
            <button
              className={tab === 'new' ? 'active' : ''}
              onClick={() => navigate('/cashier/new')}
              title="New order"
            >
              <Plus />
              New order
            </button>
          )}
          <button
            className={tab === 'handovers' ? 'active' : ''}
            onClick={() => navigate('/cashier/handovers')}
            title="Cash handovers"
          >
            <HandCoins />
            Cash handovers {pendingHandovers > 0 && <b>{pendingHandovers}</b>}
          </button>
          <button
            className={tab === 'payments' ? 'active' : ''}
            onClick={() => navigate('/cashier/payments')}
            title={config.card ? 'Payments' : 'Mobile money'}
          >
            <Smartphone />
            {config.card ? 'Payments' : 'Mobile money'}{' '}
            {pendingPayments > 0 && <b>{pendingPayments}</b>}
          </button>
          <button
            className={tab === 'payouts' ? 'active' : ''}
            onClick={() => navigate('/cashier/payouts')}
            title="Payouts"
          >
            <Banknote />
            Payouts
          </button>
          {/* Always shown: the page explains how to switch the drawer on. */}
          <button
            className={tab === 'drawer' ? 'active' : ''}
            onClick={() => navigate('/cashier/drawer')}
            title="Drawer"
          >
            <Archive />
            Drawer
          </button>
          <button
            className={tab === 'stock' ? 'active' : ''}
            onClick={() => navigate('/cashier/stock')}
            title="Stock"
          >
            <Package />
            Stock
          </button>
          <button
            className={tab === 'shift' ? 'active' : ''}
            onClick={() => navigate('/cashier/shift')}
            title="Shift"
          >
            <Clock3 />
            Shift
          </button>
          {profile?.role === 'admin' && (
            <button onClick={() => navigate('/admin')} title="Admin">
              <LayoutDashboard />
              Admin
            </button>
          )}
        </nav>
        <button
          className={`shift-live profile-link ${pathname.startsWith('/cashier/profile') ? 'active' : ''}`}
          onClick={() => navigate('/cashier/profile')}
          aria-label="Your profile"
        >
          {profile ? `${profile.code ? `${profile.code} · ` : ''}${profile.name}` : 'Cashier'}
        </button>
        <NotificationBell />
        <button className="icon-button" onClick={() => void logout()} aria-label="Log out">
          <LogOut />
        </button>
      </header>
      {!preview && <PushPrompt card />}
      {!preview && <InstallPrompt />}
      {pathname.startsWith('/cashier/profile') ? (
        <CashierProfile />
      ) : onShift === null ? (
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
          <ShiftPanel
            kind="cashier"
            preview={preview}
            onChanged={() => {
              // A new shift opens on the kitchen board.
              navigate('/cashier', { replace: true });
              void checkShift();
            }}
          />
        </div>
      ) : (
        <Routes>
          <Route index element={<KitchenBoard />} />
          {takesOrders && (
            <Route
              path="new"
              element={
                <div className="counter-order">
                  <NewOrder
                    preview={preview}
                    counter={{ callIn: !!modules?.callIn, counter: !!modules?.counter }}
                    onBack={() => navigate('/cashier')}
                    onGoToCash={() => navigate('/cashier')}
                    onOpenOrder={() => navigate('/cashier')}
                    onPlaced={async (payload) => {
                      const placed = await Parse.Cloud.run('createCounterOrder', payload);
                      // Cash taken at the counter now: open the drawer.
                      const p = payload as Record<string, unknown>;
                      if (
                        config.drawer?.onSale &&
                        p.orderType !== 'delivery' &&
                        p.payLater !== true &&
                        (p.paymentMethod || 'cash') === 'cash'
                      )
                        void openDrawer('sale', { ref: placed?.id });
                      return placed;
                    }}
                  />
                </div>
              }
            />
          )}
          <Route path="handovers" element={<CashierHandovers preview={preview} />} />
          <Route path="stock" element={<StockPanel />} />
          <Route path="payments" element={<MobileMoneyLedger />} />
          <Route path="payouts" element={<CashierPayouts />} />
          <Route path="drawer" element={<CashierDrawer />} />
          <Route
            path="shift"
            element={
              <div className="ops-content">
                <ShiftPanel
                  kind="cashier"
                  preview={preview}
                  onChanged={() => {
                    // A new shift opens on the kitchen board.
                    navigate('/cashier', { replace: true });
                    void checkShift();
                  }}
                />
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
  const { preview, config, user, profile } = useSession();
  const money = useMoney();
  const me = user?.id || '';
  const isCashier = profile?.role === 'cashier';
  const myBranch = isCashier ? profile?.branch?.id : null;
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [passing, setPassing] = useState<string | null>(null);
  const [colleagues, setColleagues] = useState<{ id: string; name: string }[] | null>(null);
  const [passTo, setPassTo] = useState('');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState<{
    id: string;
    action: 'reject' | 'cancel' | 'payment';
  } | null>(null);
  const [reason, setReason] = useState('');
  // Assigning a rider to a call-in delivery, or taking payment for a bill.
  const [assigning, setAssigning] = useState<string | null>(null);
  const [riders, setRiders] = useState<
    { id: string; name: string; onShift: boolean; available: boolean }[] | null
  >(null);
  const [riderPick, setRiderPick] = useState('');
  const [paying, setPaying] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<'cash' | 'mobile_money' | 'card'>('cash');
  const [payProvider, setPayProvider] = useState('');
  const [payRef, setPayRef] = useState('');
  // Automatic payments: the number to send the request to, and the ticket
  // whose request is on its way.
  const [payPhone, setPayPhone] = useState('');
  const [requesting, setRequesting] = useState<{ id: string; code: string } | null>(null);

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
            holderId: '',
            holderName: '',
            orderType: 'delivery',
            fromCounter: false,
            riderId: '',
            billOpen: false,
            table: '',
          })),
        );
      } else {
        setTickets(await loadLiveTickets(myBranch));
      }
      setError('');
    } catch {
      setError('Could not refresh the live board.');
    }
  }, [preview, myBranch]);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(['Order'], () => void load(), { enabled: !preview });

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

  const openPass = async (ticket: Ticket) => {
    setPassing(ticket.id);
    setPassTo('');
    setColleagues(null);
    try {
      setColleagues(await Parse.Cloud.run('getOnShiftCashiers'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load colleagues on shift');
      setColleagues([]);
    }
  };

  const pass = async (ticket: Ticket) => {
    try {
      await Parse.Cloud.run('transferOrder', { orderId: ticket.id, toUserId: passTo });
      setPassing(null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not transfer the order');
      return;
    }
    await load();
  };

  const openAssign = async (ticket: Ticket) => {
    setAssigning(ticket.id);
    setRiderPick('');
    setRiders(null);
    try {
      setRiders(await Parse.Cloud.run('getAssignableRiders'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load riders');
      setRiders([]);
    }
  };

  const assignRider = async (ticket: Ticket) => {
    try {
      await Parse.Cloud.run('assignOrderRider', { orderId: ticket.id, riderId: riderPick });
      setAssigning(null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not assign the rider');
      return;
    }
    await load();
  };

  const takePayment = async (ticket: Ticket) => {
    const request = payMethod === 'mobile_money' && autoFor(payProvider) && !payRef.trim();
    try {
      await Parse.Cloud.run('takeCounterPayment', {
        orderId: ticket.id,
        paymentMethod: payMethod,
        ...(payMethod === 'mobile_money' && {
          paymentProvider: payProvider,
          paymentReference: payRef.trim(),
          ...(request && { payerPhone: payPhone }),
        }),
        ...(payMethod === 'card' && { paymentProvider: 'card', paymentReference: payRef.trim() }),
      });
      if (request) setRequesting({ id: ticket.id, code: ticket.code });
      if (payMethod === 'cash' && config.drawer?.onSale)
        void openDrawer('payment', { ref: ticket.id });
      setPaying(null);
      setPayRef('');
      setPayPhone('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the payment');
      return;
    }
    await load();
  };

  const autoFor = (provider: string) =>
    !!(config.mobileMoney || []).find((m) => m.provider === provider)?.auto;
  const { print, printError } = usePrint();
  const visible = tickets.filter((t) => !mineOnly || !t.holderId || t.holderId === me);

  return (
    <div className="ops-content">
      {(error || printError) && <div className="ops-error">{error || printError}</div>}
      {requesting && (
        <div className="request-banner">
          <b>{requesting.code}</b>
          <PaymentRequestStatus orderId={requesting.id} onSettled={() => void load()} />
          <button className="link-button" onClick={() => setRequesting(null)}>
            Close
          </button>
        </div>
      )}
      <div className="ops-title">
        <div>
          <h1>Kitchen board</h1>
        </div>
        <span>
          <Clock3 /> Updates live
        </span>
      </div>
      {isCashier && !preview && (
        <div className="filter-toggle board-filter" role="group" aria-label="Show orders">
          <button className={mineOnly ? '' : 'active'} onClick={() => setMineOnly(false)}>
            All orders
          </button>
          <button className={mineOnly ? 'active' : ''} onClick={() => setMineOnly(true)}>
            Mine and new
          </button>
        </div>
      )}
      <div className="board-grid">
        {(['Incoming', 'Preparing', 'Ready'] as const).map((stage) => (
          <section className="board-column" key={stage}>
            <header>
              <span className={`board-dot ${stage.toLowerCase()}`} />
              <h2>{stage}</h2>
              <b>{visible.filter((t) => t.stage === stage).length}</b>
            </header>
            {visible
              .filter((t) => t.stage === stage)
              .map((ticket) => {
                const age = minutesSince(ticket.createdAt);
                const isClosing = closing?.id === ticket.id;
                const mine = !!ticket.holderId && ticket.holderId === me;
                const heldByOther = isCashier && !!ticket.holderId && !mine;
                const canPass = !preview && (!isCashier || !heldByOther);
                return (
                  <article className={heldByOther ? 'ticket held' : 'ticket'} key={ticket.id}>
                    <div className="ticket-top">
                      <b>{ticket.code}</b>
                      <span>{money(ticket.total)}</span>
                    </div>
                    <div className="ticket-meta">
                      {ticket.createdAt && (
                        <span
                          className={age >= (ticket.prepMinutes || 20) ? 'late' : ''}
                          title={
                            ticket.prepMinutes
                              ? `Prep time ${ticket.prepMinutes} min`
                              : 'Late after 20 min'
                          }
                        >
                          {age} min
                          {ticket.prepMinutes ? ` / ${ticket.prepMinutes}` : ''}
                        </span>
                      )}
                      {TYPE_LABEL[ticket.orderType] && (
                        <span className="ticket-type">
                          {TYPE_LABEL[ticket.orderType]}
                          {ticket.table ? ` · ${ticket.table}` : ''}
                        </span>
                      )}
                      {ticket.channel && <span>{CHANNEL[ticket.channel] || ticket.channel}</span>}
                      {ticket.billOpen ? (
                        <span className="ticket-unpaid">Not paid</span>
                      ) : (
                        ticket.payment && <span>{PAYMENT[ticket.payment] || ticket.payment}</span>
                      )}
                    </div>
                    <h3>{ticket.customer}</h3>
                    {ticket.lines.some((line) => line.split) && (
                      <p className="ticket-split-note">
                        Split order · {new Set(ticket.lines.map((line) => line.split)).size} splits
                      </p>
                    )}
                    {groupBySplit(ticket.lines).map((group) => (
                      <div key={group.split || 'all'} className={group.split ? 'ticket-split' : ''}>
                        {group.split && <p className="ticket-split-name">{group.split}</p>}
                        <ul className="ticket-lines">
                          {group.lines.map((line, index) => (
                            <li key={index}>
                              {line.text}
                              {line.details && <small>{line.details}</small>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {ticket.issue && <p className="ticket-issue">⚠ {ticket.issue}</p>}
                    {ticket.paymentStatus && (
                      <p className={`ticket-payment payment-${ticket.paymentStatus.toLowerCase()}`}>
                        {providerLabel(ticket.paymentProvider)} · {ticket.paymentReference} ·{' '}
                        {ticket.paymentStatus === 'VERIFIED'
                          ? 'paid ✓'
                          : ticket.paymentStatus === 'REJECTED'
                            ? ticket.billOpen
                              ? 'not received: take payment again'
                              : 'not received: waiting for rider'
                            : 'check payment'}
                      </p>
                    )}
                    {ticket.orderType === 'delivery' && (
                      <small className={ticket.riderId ? '' : 'ticket-norider'}>
                        {ticket.riderId ? ticket.rider : 'No rider yet'}
                        {ticket.fromCounter && ' · counter order'}
                      </small>
                    )}
                    {!preview && (
                      <p className={mine ? 'ticket-holder mine' : 'ticket-holder'}>
                        {mine
                          ? 'You are handling this'
                          : ticket.holderName
                            ? `Handled by ${ticket.holderName}`
                            : 'Not taken yet'}
                      </p>
                    )}
                    {assigning === ticket.id ? (
                      <div className="ticket-close">
                        <select
                          aria-label="Rider"
                          value={riderPick}
                          onChange={(e) => setRiderPick(e.target.value)}
                        >
                          <option value="">Choose a rider</option>
                          {(riders || [])
                            .filter((r) => r.id !== ticket.riderId)
                            .map((r) => (
                              <option key={r.id} value={r.id} disabled={r.onShift && !r.available}>
                                {r.name}
                                {!r.onShift ? ' (off shift)' : !r.available ? ' (on a break)' : ''}
                              </option>
                            ))}
                        </select>
                        <small>
                          The rider earns the delivery fee on this order, no commission.
                        </small>
                        <div className="ticket-actions">
                          <button onClick={() => setAssigning(null)}>Back</button>
                          <button disabled={!riderPick} onClick={() => void assignRider(ticket)}>
                            Assign
                          </button>
                        </div>
                      </div>
                    ) : paying === ticket.id ? (
                      <div className="ticket-close">
                        <div className="filter-toggle" role="group" aria-label="Paid by">
                          {(
                            [
                              ['cash', 'Cash'],
                              ['mobile_money', 'Mobile money'],
                              ...(config.card ? ([['card', 'Card']] as const) : []),
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              className={payMethod === value ? 'active' : ''}
                              onClick={() => setPayMethod(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {payMethod === 'mobile_money' ? (
                          <>
                            <select
                              aria-label="Network"
                              value={payProvider}
                              onChange={(e) => setPayProvider(e.target.value)}
                            >
                              <option value="">Choose the network</option>
                              {(config.mobileMoney || []).map((m) => (
                                <option key={m.provider} value={m.provider}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                            {autoFor(payProvider) && (
                              <input
                                value={payPhone}
                                onChange={(e) => setPayPhone(e.target.value)}
                                inputMode="tel"
                                placeholder="Customer’s number, for a payment request"
                              />
                            )}
                            <input
                              value={payRef}
                              onChange={(e) => setPayRef(e.target.value.toUpperCase())}
                              placeholder={
                                autoFor(payProvider)
                                  ? 'Or the transaction ID, if they paid the code'
                                  : 'Transaction ID'
                              }
                            />
                          </>
                        ) : payMethod === 'card' ? (
                          <>
                            <small>
                              Charge {money(ticket.total)} on the {config.card?.label || 'card'}{' '}
                              machine.
                            </small>
                            <input
                              value={payRef}
                              onChange={(e) => setPayRef(e.target.value.toUpperCase())}
                              placeholder="Transaction ID on the slip"
                            />
                          </>
                        ) : (
                          <small>Put {money(ticket.total)} in the till.</small>
                        )}
                        <div className="ticket-actions">
                          <button onClick={() => setPaying(null)}>Back</button>
                          <button
                            disabled={
                              (payMethod === 'card' && !!referenceProblem(payRef)) ||
                              (payMethod === 'mobile_money' &&
                                (!payProvider ||
                                  (!payRef.trim() &&
                                    (!autoFor(payProvider) || !!payerPhoneProblem(payPhone)))))
                            }
                            onClick={() => void takePayment(ticket)}
                          >
                            <Check />{' '}
                            {payMethod === 'mobile_money' && autoFor(payProvider) && !payRef.trim()
                              ? 'Send request'
                              : 'Paid'}
                          </button>
                        </div>
                      </div>
                    ) : passing === ticket.id ? (
                      <div className="ticket-close">
                        <select
                          aria-label="Pass to"
                          value={passTo}
                          onChange={(e) => setPassTo(e.target.value)}
                        >
                          <option value="">Anyone on shift (release it)</option>
                          {(colleagues || []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        {colleagues && !colleagues.length && (
                          <small>No other cashier is on shift right now.</small>
                        )}
                        <div className="ticket-actions">
                          <button onClick={() => setPassing(null)}>Back</button>
                          <button onClick={() => void pass(ticket)}>
                            {passTo ? 'Transfer' : 'Release'}
                          </button>
                        </div>
                      </div>
                    ) : heldByOther ? (
                      <p className="ticket-held">
                        Ask {ticket.holderName.split(' · ').pop()} to transfer it if you need to
                        take over.
                      </p>
                    ) : isClosing ? (
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
                        {ticket.billOpen && (
                          <button
                            className="pay-button"
                            onClick={() => {
                              setPaying(ticket.id);
                              setPayMethod('cash');
                              setPayProvider('');
                              setPayRef('');
                            }}
                          >
                            <Banknote /> Take payment
                          </button>
                        )}
                        {stage === 'Ready' && TYPE_LABEL[ticket.orderType] && (
                          <button
                            disabled={
                              ticket.billOpen || ticket.paymentStatus === 'PENDING_VERIFICATION'
                            }
                            title={ticket.billOpen ? 'Take payment first' : undefined}
                            onClick={() => void run(ticket, 'complete')}
                          >
                            <ClipboardCheck />
                            {ticket.orderType === 'pickup' ? 'Collected' : 'Served'}
                          </button>
                        )}
                        {stage === 'Ready' &&
                          ticket.orderType === 'delivery' &&
                          (ticket.riderId ? (
                            <button onClick={() => void run(ticket, 'pickup')}>
                              <ClipboardCheck />
                              Hand to rider
                            </button>
                          ) : (
                            <button onClick={() => void openAssign(ticket)}>Assign rider</button>
                          ))}
                      </div>
                    )}
                    {!isClosing &&
                      passing !== ticket.id &&
                      assigning !== ticket.id &&
                      paying !== ticket.id &&
                      !heldByOther &&
                      !preview && (
                        <div className="ticket-links">
                          {stage !== 'Incoming' && (
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
                          {ticket.fromCounter &&
                            ticket.orderType === 'delivery' &&
                            (stage !== 'Ready' || ticket.riderId) && (
                              <button
                                className="link-button"
                                onClick={() => void openAssign(ticket)}
                              >
                                {ticket.riderId ? 'Change rider' : 'Assign rider'}
                              </button>
                            )}
                          <button
                            className="link-button"
                            onClick={() => void print(ticket.id, 'kitchen')}
                          >
                            Print ticket
                          </button>
                          <button
                            className="link-button"
                            onClick={() => void print(ticket.id, 'receipt')}
                          >
                            Receipt
                          </button>
                          {canPass && (mine || !ticket.holderId || !isCashier) && (
                            <button className="link-button" onClick={() => void openPass(ticket)}>
                              Pass to a colleague
                            </button>
                          )}
                        </div>
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
// Per branch: a cashier changes their own branch; the owner picks one, or
// "every branch" to sell something out everywhere.
function StockPanel() {
  const { preview } = useSession();
  const branches = useBranchOptions();
  const [branchId, setBranchId] = useState('');
  const [stock, setStock] = useState<{
    branch: { id: string; name: string } | null;
    items: {
      id: string;
      title: string;
      category: string;
      available: boolean;
      everywhere?: boolean;
    }[];
    accompaniments: { id: string; title: string; available: boolean; everywhere?: boolean }[];
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (preview) return;
    try {
      setStock(await Parse.Cloud.run('getStock', branchId ? { branchId } : {}));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load stock');
    }
  }, [preview, branchId]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (type: 'menuItem' | 'accompaniment', id: string, available: boolean) => {
    setBusy(id);
    try {
      await Parse.Cloud.run('setAvailability', {
        type,
        id,
        available,
        ...(branchId && { branchId }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy('');
    }
  };

  const row = (
    type: 'menuItem' | 'accompaniment',
    entry: { id: string; title: string; available: boolean; everywhere?: boolean },
    detail?: string,
  ) => (
    <div className={entry.available ? 'stock-row' : 'stock-row sold-out'} key={entry.id}>
      <div>
        <b>{entry.title}</b>
        {detail && <small>{detail}</small>}
      </div>
      <span>
        {entry.available
          ? 'Available'
          : entry.everywhere && stock?.branch
            ? 'Sold out everywhere'
            : 'Sold out'}
      </span>
      <button
        disabled={busy === entry.id || (!!entry.everywhere && !!stock?.branch)}
        title={
          entry.everywhere && stock?.branch
            ? 'Sold out at every branch: the owner brings it back'
            : undefined
        }
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
        <span>
          Sold-out items disappear from riders’ menus straight away
          {stock?.branch ? ` at ${stock.branch.name}` : ''}.
        </span>
      </div>
      {branches.length > 1 && (
        <div className="filter-bar">
          <BranchSelect
            value={branchId}
            onChange={setBranchId}
            branches={branches.filter((b) => b.active)}
            allLabel="Every branch"
          />
        </div>
      )}
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
  holderId: string;
  holderName: string;
  // Automatic payments (Admin → Payments).
  payRequest: string;
  payRequestError: string;
  auto: boolean;
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
  const { preview, config, user, profile } = useSession();
  const me = user?.id || '';
  const isCashier = profile?.role === 'cashier';
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
  }, [load]);
  useLiveRefresh(['Order'], () => void load(), { enabled: !preview });

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
      {row.reference ? (
        <span className="code">{row.reference}</span>
      ) : ['queued', 'pending'].includes(row.payRequest) ? (
        <small>Request sent · waiting for the customer to approve</small>
      ) : (
        <small>Payment request</small>
      )}
      {row.auto && row.paymentStatus === 'VERIFIED' && <small>Confirmed automatically</small>}
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
          <h1>{config.card ? 'Mobile money & card' : 'Mobile money'}</h1>
        </div>
        <span>
          Check each transaction ID on the merchant account
          {config.card ? ' or the card machine report' : ''} before confirming.
        </span>
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
                label={[t.label, t.code].filter(Boolean).join(' · ')}
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
                          {isCashier && row.holderId && row.holderId !== me ? (
                            <span className="muted">{row.holderName} has this order</span>
                          ) : rejecting === row.id ? (
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
