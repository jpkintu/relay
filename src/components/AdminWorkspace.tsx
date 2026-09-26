import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  Bike,
  UtensilsCrossed,
  Menu,
  X,
  ClipboardList,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Settings,
  Users,
  CircleDollarSign,
} from 'lucide-react';
import Parse from '../parse';
import { AdminOrders, type AdminOrder } from './AdminOrders';
import { AdminSetup } from './AdminSetup';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate, isToday } from '../lib/format';
import { personLabel } from '../lib/people';
import { useDevice } from '../lib/device';

const NAV = [
  [LayoutDashboard, 'Overview', ''],
  [ClipboardList, 'Orders', 'orders'],
  [HandCoins, 'Cash ledger', 'cash'],
  [CircleDollarSign, 'Commissions', 'commissions'],
  [Users, 'Team', 'team'],
  [ClipboardList, 'Menu', 'menu'],
  [Settings, 'Settings', 'settings'],
] as const;
type Section = (typeof NAV)[number][1];

export function AdminWorkspace() {
  const { preview, logout } = useSession();
  const { timezone } = useConfig();
  const money = useMoney();
  const navigate = useNavigate();
  const device = useDevice();
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = device === 'phone' || device === 'tablet';
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const slug = useLocation().pathname.split('/')[2] || '';
  const current = NAV.find((entry) => entry[2] === slug);
  const section: Section = current ? current[1] : 'Overview';
  const setSection = (label: Section) =>
    navigate(`/admin/${NAV.find((entry) => entry[1] === label)?.[2] ?? ''}`);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [handovers, setHandovers] = useState<
    {
      id: string;
      code: string;
      amount: number;
      status: string;
      rider: string;
      reason: string;
      countedAmount: number | null;
      createdAt: Date;
    }[]
  >([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      if (preview) {
        const rows: {
          id: string;
          code: string;
          rider: string;
          customer: string;
          status: string;
          total: number;
        }[] = await Parse.Cloud.run('getPreviewOrders');
        setOrders(
          rows.map((o) => ({
            ...o,
            amountCollected: 0,
            cashStatus: 'Demo',
            commission: 0,
            createdAt: new Date(),
          })),
        );
        setHandovers([]);
      } else {
        const orderQ = new Parse.Query('Order');
        orderQ.include('createdBy');
        orderQ.descending('createdAt');
        orderQ.limit(100);
        const handoverQ = new Parse.Query('CashHandover');
        handoverQ.include('rider');
        handoverQ.descending('createdAt');
        handoverQ.limit(100);
        const [orderRows, cashRows] = await Promise.all([orderQ.find(), handoverQ.find()]);
        setOrders(
          orderRows.map((o) => ({
            id: o.id!,
            code: o.get('orderCode'),
            rider: personLabel(o.get('createdBy')),
            customer: o.get('customerName'),
            status: o.get('status'),
            total: o.get('total'),
            amountCollected: o.get('amountCollected') || 0,
            cashStatus: o.get('cashStatus'),
            commission: o.get('commissionAmount') || 0,
            createdAt: o.createdAt || new Date(),
          })),
        );
        setHandovers(
          cashRows.map((h) => ({
            id: h.id!,
            code: h.get('handoverCode'),
            amount: h.get('amount'),
            status: h.get('status'),
            rider: personLabel(h.get('rider')),
            reason: h.get('disputeReason') || '',
            countedAmount: h.get('countedAmount') ?? null,
            createdAt: h.createdAt || new Date(),
          })),
        );
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load operations');
    }
  }, [preview]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (!current) return <Navigate to="/admin" replace />;
  const today = orders.filter((o) => isToday(o.createdAt, timezone));
  const cashWithRiders = orders
    .filter(
      (o) => o.status === 'DELIVERED' && ['WITH_RIDER', 'HANDOVER_PENDING'].includes(o.cashStatus),
    )
    .reduce((n, o) => n + o.amountCollected, 0);
  return (
    <main className="admin-shell">
      <aside className={menuOpen && compact ? 'admin-side menu-open' : 'admin-side'}>
        <div className="brand-mark">
          <Bike />
          <span>Relay</span>
        </div>
        <p>Restaurant operations</p>
        {compact && (
          <button
            className="admin-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="admin-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X /> : <Menu />}
            {menuOpen ? 'Close' : section}
          </button>
        )}
        <nav id="admin-nav" aria-label="Admin sections">
          {NAV.map(([Icon, label]) => (
            <button
              key={label}
              className={section === label ? 'active' : ''}
              aria-current={section === label ? 'page' : undefined}
              onClick={() => {
                setSection(label);
                setMenuOpen(false);
              }}
            >
              <Icon />
              {label}
            </button>
          ))}
          <button onClick={() => navigate('/cashier')}>
            <UtensilsCrossed />
            Kitchen board
          </button>
          <button className="admin-logout" onClick={() => void logout()}>
            <LogOut />
            Log out
          </button>
        </nav>
      </aside>
      {compact && menuOpen && (
        <div className="admin-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden />
      )}
      <section className="admin-main">
        <header>
          <div>
            <p className="eyebrow">
              {formatDate(new Date(), timezone, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
            <h1>{section === 'Overview' ? 'Restaurant overview' : section}</h1>
          </div>
          <button className="refresh-button" onClick={() => void load()}>
            Refresh data
          </button>
        </header>
        {error && <p className="ops-error">{error}</p>}
        {section === 'Overview' && (
          <>
            <div className="admin-metrics">
              <article>
                <span>Gross sales today</span>
                <strong>
                  {money(
                    today.filter((o) => o.status === 'DELIVERED').reduce((n, o) => n + o.total, 0),
                  )}
                </strong>
                <small>Delivered orders</small>
              </article>
              <article>
                <span>Orders today</span>
                <strong>{today.length}</strong>
                <small>
                  {today.filter((o) => !['DELIVERED', 'CANCELLED'].includes(o.status)).length} in
                  flight
                </small>
              </article>
              <article>
                <span>Cash with riders</span>
                <strong>{money(cashWithRiders)}</strong>
                <small>Delivered cash orders not reconciled</small>
              </article>
              <article>
                <span>Commission earned today</span>
                <strong>{money(today.reduce((n, o) => n + o.commission, 0))}</strong>
                <small>Recorded on delivered orders</small>
              </article>
            </div>
            <section className="admin-panel recent-table">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Live feed</p>
                  <h2>Recent orders</h2>
                </div>
                <button onClick={() => setSection('Orders')}>View all orders</button>
              </div>
              {orders.slice(0, 20).map((o) => (
                <div className="table-row" key={o.id}>
                  <span>{o.code}</span>
                  <span>{o.rider}</span>
                  <span>{o.customer}</span>
                  <span className="status-pill">{o.status}</span>
                  <span>{money(o.total)}</span>
                </div>
              ))}
              {!orders.length && (
                <p className="empty-orders">No orders yet. New tickets will appear here.</p>
              )}
            </section>
          </>
        )}
        {section === 'Orders' && <AdminOrders orders={orders} />}
        {section === 'Cash ledger' && (
          <section className="admin-panel admin-section-panel">
            <div className="panel-title">
              <h2>Cash handovers</h2>
              <strong>
                {money(
                  handovers
                    .filter((h) => h.status === 'confirmed')
                    .reduce((n, h) => n + h.amount, 0),
                )}{' '}
                confirmed
              </strong>
            </div>
            {handovers.map((h) => (
              <div key={h.id}>
                <div className="table-row">
                  <span>{h.code}</span>
                  <span>{h.rider}</span>
                  <span className="status-pill">{h.status}</span>
                  <span>{money(h.amount)}</span>
                  <span>{formatDate(h.createdAt, timezone, { dateStyle: 'medium' })}</span>
                </div>
                {h.status === 'disputed' && (
                  <DisputeResolution handover={h} onResolved={() => void load()} />
                )}
              </div>
            ))}
            {!handovers.length && <p className="empty-orders">No handovers recorded yet.</p>}
          </section>
        )}
        {section === 'Commissions' && (
          <section className="admin-panel admin-section-panel">
            <h2>Commission ledger</h2>
            {orders
              .filter((o) => o.commission > 0)
              .map((o) => (
                <div className="table-row" key={o.id}>
                  <span>{o.code}</span>
                  <span>{o.rider}</span>
                  <span>{o.customer}</span>
                  <span>{o.status}</span>
                  <strong>{money(o.commission)}</strong>
                </div>
              ))}
            {!orders.some((o) => o.commission > 0) && (
              <p className="empty-orders">Commissions appear when orders are delivered.</p>
            )}
          </section>
        )}
        {['Team', 'Menu', 'Settings'].includes(section) && (
          <AdminSetup section={section as 'Team' | 'Menu' | 'Settings'} preview={preview} />
        )}
      </section>
    </main>
  );
}

function DisputeResolution({
  handover,
  onResolved,
}: {
  handover: { id: string; reason: string; amount: number; countedAmount: number | null };
  onResolved: () => void;
}) {
  const money = useMoney();
  const [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reopen = async () => {
    if (note.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('reopenHandover', { handoverId: handover.id, note });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reopen dispute');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dispute-panel">
      <strong>
        Disputed cash count: {money(handover.countedAmount || 0)} / claimed {money(handover.amount)}
      </strong>
      <p>{handover.reason}</p>
      <label>
        Resolution note
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Record how this was resolved"
        />
      </label>
      <button disabled={busy || note.trim().length < 5} onClick={() => void reopen()}>
        Return to cashier for recount
      </button>
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}
