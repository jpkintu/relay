import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Bike,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Package,
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
  }));
}

const minutesSince = (date: Date | null) =>
  date ? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000)) : 0;

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

  useEffect(() => {
    if (preview) return;
    const refresh = () =>
      countPendingHandovers()
        .then(setPendingHandovers)
        .catch(() => undefined);
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
        : 'orders';
  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div className="brand-mark dark">
          <Bike />
          <span>Relay</span>
        </div>
        <nav>
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
        <button className="icon-button" onClick={() => void logout()} aria-label="Log out">
          <LogOut />
        </button>
      </header>
      <Routes>
        <Route index element={<KitchenBoard />} />
        <Route path="handovers" element={<CashierHandovers preview={preview} />} />
        <Route path="stock" element={<StockPanel />} />
        <Route
          path="shift"
          element={
            <div className="ops-content">
              <ShiftPanel kind="cashier" preview={preview} />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/cashier" replace />} />
      </Routes>
    </main>
  );
}

function KitchenBoard() {
  const { preview, config } = useSession();
  const money = useMoney();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState<{ id: string; action: 'reject' | 'cancel' } | null>(null);
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
          <p className="eyebrow">Live service</p>
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
                              : 'Why cancel?'
                          }
                        />
                        <div className="ticket-actions">
                          <button onClick={() => setClosing(null)}>Back</button>
                          <button
                            className="reject"
                            disabled={reason.trim().length < 3}
                            onClick={async () => {
                              if (await run(ticket, closing.action, { reason })) {
                                setClosing(null);
                                setReason('');
                              }
                            }}
                          >
                            <X />
                            {closing.action === 'reject' ? 'Reject order' : 'Cancel order'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="ticket-actions">
                        {stage === 'Incoming' && (
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
          <p className="eyebrow">Service</p>
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
