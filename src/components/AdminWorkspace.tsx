import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
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
  BarChart3,
  TriangleAlert,
} from 'lucide-react';
import Parse from '../parse';
import { AdminOrders } from './AdminOrders';
import { AdminProblems } from './AdminProblems';
import { PaymentsLedger } from './reports/PaymentsLedger';
import { Commissions } from './reports/Commissions';
import { Reports } from './reports/Reports';
import { AdminSetup } from './AdminSetup';
import { BrandMark } from './BrandMark';
import { statusLabel, statusTone } from '../lib/labels';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate, isToday } from '../lib/format';
import { personLabel } from '../lib/people';
import { useDevice } from '../lib/device';
import { riderPayOf } from '../lib/pay';
import { NotificationBell } from './NotificationBell';

type AdminOrder = {
  id: string;
  code: string;
  rider: string;
  customer: string;
  status: string;
  total: number;
  amountCollected: number;
  cashStatus: string;
  commission: number;
  createdAt: Date;
};

const NAV = [
  [LayoutDashboard, 'Overview', ''],
  [BarChart3, 'Reports', 'reports'],
  [ClipboardList, 'Orders', 'orders'],
  [TriangleAlert, 'Problems', 'problems'],
  [HandCoins, 'Payments ledger', 'payments'],
  [CircleDollarSign, 'Commissions', 'commissions'],
  [Users, 'Team', 'team'],
  [ClipboardList, 'Menu', 'menu'],
  [Settings, 'Settings', 'settings'],
] as const;
type Section = (typeof NAV)[number][1];

export function AdminWorkspace() {
  const { preview, logout } = useSession();
  const { timezone, restaurantNameSet } = useConfig();
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
  const [error, setError] = useState('');
  const [openIssues, setOpenIssues] = useState(0);
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
      } else {
        const orderQ = new Parse.Query('Order');
        orderQ.include('createdBy');
        orderQ.descending('createdAt');
        orderQ.limit(100);
        const [orderRows, issues] = await Promise.all([
          orderQ.find(),
          Parse.Cloud.run('adminListIssues', { state: 'open' }) as Promise<{ open: number }>,
        ]);
        setOpenIssues(issues.open);
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
            commission: o.get('status') === 'DELIVERED' ? riderPayOf(o) : 0,
            createdAt: o.createdAt || new Date(),
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
  if (slug === 'cash') return <Navigate to="/admin/payments" replace />;
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
        <BrandMark onDark />
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
              {label === 'Problems' && openIssues > 0 && (
                <span className="nav-count">{openIssues}</span>
              )}
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
          <div className="header-actions">
            {section === 'Overview' && (
              <button className="refresh-button" onClick={() => void load()}>
                Refresh data
              </button>
            )}
            <NotificationBell />
          </div>
        </header>
        {error && <p className="ops-error">{error}</p>}
        {section === 'Overview' && (
          <>
            {restaurantNameSet === false && !preview && (
              <div className="setup-notice">
                <span>
                  Your restaurant name is not set, so riders and the sign-in screen show
                  “Restaurant”.
                </span>
                <button onClick={() => setSection('Settings')}>Set the name</button>
              </div>
            )}
            <div className="admin-metrics">
              <article>
                <span>Sales after rider pay today</span>
                <strong>
                  {money(
                    today
                      .filter((o) => o.status === 'DELIVERED')
                      .reduce((n, o) => n + o.total - o.commission, 0),
                  )}
                </strong>
                <small>
                  Gross{' '}
                  {money(
                    today.filter((o) => o.status === 'DELIVERED').reduce((n, o) => n + o.total, 0),
                  )}{' '}
                  · less commission and delivery fees
                </small>
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
                <span>Rider pay earned today</span>
                <strong>{money(today.reduce((n, o) => n + o.commission, 0))}</strong>
                <small>Recorded on delivered orders</small>
              </article>
            </div>
            <section className="admin-panel recent-table">
              <div className="panel-title">
                <h2>Recent orders</h2>
                <button className="link-button" onClick={() => setSection('Orders')}>
                  View all orders
                </button>
              </div>
              {orders.length > 0 && (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Rider</th>
                        <th>Status</th>
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.slice(0, 20).map((o) => (
                        <tr key={o.id}>
                          <td>
                            <span className="code">{o.code}</span>
                            <small>{o.customer}</small>
                          </td>
                          <td>{o.rider}</td>
                          <td>
                            <span className={`status-pill ${statusTone(o.status)}`}>
                              {statusLabel(o.status)}
                            </span>
                          </td>
                          <td className="num">{money(o.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!orders.length && (
                <p className="empty-orders">No orders yet. New tickets will appear here.</p>
              )}
            </section>
          </>
        )}
        {preview &&
        ['Reports', 'Orders', 'Problems', 'Payments ledger', 'Commissions'].includes(section) ? (
          <p className="info-card">Sign in as the owner to see reports and ledgers.</p>
        ) : (
          <>
            {section === 'Reports' && <Reports />}
            {section === 'Orders' && <AdminOrders />}
            {section === 'Problems' && <AdminProblems onChanged={() => void load()} />}
            {section === 'Payments ledger' && <PaymentsLedger />}
            {section === 'Commissions' && <Commissions />}
          </>
        )}
        {['Team', 'Menu', 'Settings'].includes(section) && (
          <AdminSetup section={section as 'Team' | 'Menu' | 'Settings'} preview={preview} />
        )}
      </section>
    </main>
  );
}
