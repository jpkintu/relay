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
  Palette,
  Users,
  CircleDollarSign,
  BarChart3,
  TriangleAlert,
  History,
} from 'lucide-react';
import Parse from '../parse';
import { AdminOrders } from './AdminOrders';
import { AdminProblems } from './AdminProblems';
import { PaymentsLedger } from './reports/PaymentsLedger';
import { Commissions } from './reports/Commissions';
import { Reports } from './reports/Reports';
import { AdminSetup } from './AdminSetup';
import { AdminMember } from './AdminMember';
import { AdminOverview } from './AdminOverview';
import { AdminOrder } from './AdminOrder';
import { AuditLog } from './AuditLog';
import { ZReportPage } from './reports/ZReport';
import { BrandMark } from './BrandMark';
import { useConfig, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { useDevice } from '../lib/device';
import { NotificationBell } from './NotificationBell';
import { useLiveRefresh } from '../lib/live';

const NAV = [
  [LayoutDashboard, 'Overview', ''],
  [BarChart3, 'Reports', 'reports'],
  [ClipboardList, 'Orders', 'orders'],
  [TriangleAlert, 'Problems', 'problems'],
  [HandCoins, 'Payments ledger', 'payments'],
  [CircleDollarSign, 'Commissions', 'commissions'],
  [Users, 'Team', 'team'],
  [History, 'Audit log', 'audit'],
  [ClipboardList, 'Menu', 'menu'],
  [Palette, 'Branding', 'branding'],
  [Settings, 'Settings', 'settings'],
] as const;
type Section = (typeof NAV)[number][1];

export function AdminWorkspace() {
  const { preview, logout } = useSession();
  const { timezone, restaurantNameSet, restaurantName, restaurantLogo } = useConfig();
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
  const pathParts = useLocation().pathname.split('/');
  const slug = pathParts[2] || '';
  const memberId = slug === 'team' && !preview ? pathParts[3] || '' : '';
  const orderId = slug === 'orders' && !preview ? pathParts[3] || '' : '';
  const zDay =
    slug === 'reports' && pathParts[3] === 'z' && !preview ? pathParts[4] || 'today' : '';
  const current = NAV.find((entry) => entry[2] === slug);
  const section: Section = current ? current[1] : 'Overview';
  const setSection = (label: Section) =>
    navigate(`/admin/${NAV.find((entry) => entry[1] === label)?.[2] ?? ''}`);
  const [error, setError] = useState('');
  const [openIssues, setOpenIssues] = useState(0);
  const [version, setVersion] = useState(0);
  // The Problems count in the menu; the Overview loads its own figures.
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const issues: { open: number } = await Parse.Cloud.run('adminListIssues', { state: 'open' });
      setOpenIssues(issues.open);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load operations');
    }
  }, [preview]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(['Order'], () => void load(), {
    enabled: !preview,
    fastMs: 30000,
    slowMs: 120000,
  });
  if (slug === 'cash') return <Navigate to="/admin/payments" replace />;
  if (!current) return <Navigate to="/admin" replace />;
  return (
    <main className="admin-shell">
      <aside className={menuOpen && compact ? 'admin-side menu-open' : 'admin-side'}>
        <BrandMark onDark />
        {restaurantLogo && (
          <div className="admin-restaurant">
            <img src={restaurantLogo} alt={restaurantName} />
          </div>
        )}
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
              <button
                className="refresh-button"
                onClick={() => {
                  setVersion((n) => n + 1);
                  void load();
                }}
              >
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
            {preview ? (
              <p className="info-card">Sign in as the owner to see today&apos;s figures.</p>
            ) : (
              <AdminOverview version={version} />
            )}
          </>
        )}
        {preview &&
        ['Reports', 'Orders', 'Problems', 'Payments ledger', 'Commissions', 'Audit log'].includes(
          section,
        ) ? (
          <p className="info-card">Sign in as the owner to see reports and ledgers.</p>
        ) : (
          <>
            {section === 'Reports' && (zDay ? <ZReportPage day={zDay} /> : <Reports />)}
            {section === 'Orders' &&
              (orderId ? (
                <AdminOrder key={orderId} id={orderId} onChanged={() => void load()} />
              ) : (
                <AdminOrders />
              ))}
            {section === 'Audit log' && <AuditLog />}
            {section === 'Problems' && <AdminProblems onChanged={() => void load()} />}
            {section === 'Payments ledger' && <PaymentsLedger />}
            {section === 'Commissions' && <Commissions />}
          </>
        )}
        {memberId && <AdminMember key={memberId} id={memberId} />}
        {!memberId && ['Team', 'Menu', 'Branding', 'Settings'].includes(section) && (
          <AdminSetup
            section={section as 'Team' | 'Menu' | 'Branding' | 'Settings'}
            preview={preview}
          />
        )}
      </section>
    </main>
  );
}
