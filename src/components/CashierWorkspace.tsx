import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Bike,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
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
type Ticket = {
  id: string;
  code: string;
  rider: string;
  customer: string;
  items: string;
  total: number;
  status: string;
  stage: Stage;
};

const stageOf = (status: string): Stage =>
  status === 'PLACED' ? 'Incoming' : status === 'READY' ? 'Ready' : 'Preparing';

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
  const summary = new Map<string, string[]>();
  for (const item of items) {
    const orderId = item.get('order')?.id;
    const line = `${item.get('quantity')}× ${item.get('itemNameSnapshot')}`;
    summary.set(orderId, [...(summary.get(orderId) || []), line]);
  }
  return orders.map((order) => ({
    id: order.id!,
    code: order.get('orderCode'),
    rider: personLabel(order.get('createdBy')),
    customer: order.get('customerName'),
    items: (summary.get(order.id!) || []).join(' · ') || '—',
    total: order.get('total'),
    status: order.get('status'),
    stage: stageOf(order.get('status')),
  }));
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
  const { preview } = useSession();
  const money = useMoney();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      if (preview) {
        const rows: Omit<Ticket, 'stage'>[] = await Parse.Cloud.run('getPreviewOrders');
        setTickets(rows.map((row) => ({ ...row, stage: stageOf(row.status) })));
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

  const move = async (ticket: Ticket, stage: Stage | null) => {
    const action =
      stage === 'Preparing'
        ? ticket.stage === 'Incoming'
          ? 'accept'
          : 'prepare'
        : stage === 'Ready'
          ? 'ready'
          : ticket.stage === 'Ready'
            ? 'pickup'
            : null;
    if (!action) return;
    try {
      const fn = preview ? 'transitionPreviewOrder' : 'transitionOrder';
      if (ticket.status === 'ACCEPTED' && stage === 'Ready')
        await Parse.Cloud.run(fn, { orderId: ticket.id, action: 'prepare' });
      await Parse.Cloud.run(fn, { orderId: ticket.id, action });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Action failed');
      return;
    }
    await load();
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
              .map((ticket) => (
                <article className="ticket" key={ticket.id}>
                  <div className="ticket-top">
                    <b>{ticket.code}</b>
                    <span>{money(ticket.total)}</span>
                  </div>
                  <h3>{ticket.customer}</h3>
                  <p>{ticket.items}</p>
                  <small>{ticket.rider}</small>
                  <div className="ticket-actions">
                    {stage === 'Incoming' && (
                      <>
                        <button
                          className="reject"
                          disabled
                          title="Cancellation with reason is not available yet"
                        >
                          <X />
                          Reject
                        </button>
                        <button onClick={() => move(ticket, 'Preparing')}>
                          <Check />
                          Accept
                        </button>
                      </>
                    )}
                    {stage === 'Preparing' && (
                      <button onClick={() => move(ticket, 'Ready')}>
                        Mark ready <ChevronRight />
                      </button>
                    )}
                    {stage === 'Ready' && (
                      <button onClick={() => move(ticket, null)}>
                        <ClipboardCheck />
                        Hand to rider
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
