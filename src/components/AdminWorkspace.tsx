import { Suspense, useCallback, useEffect, useState } from 'react';
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
  Rocket,
  Bug,
} from 'lucide-react';
import Parse from '../parse';
import { AdminOverview } from './AdminOverview';
import { STEP_COUNT, stepsDone, type SetupProgress } from '../lib/setup';
import { lazyScreen } from '../lib/lazy';
import { BrandMark } from './BrandMark';
import { useConfig, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { useDevice } from '../lib/device';
import { NotificationBell } from './NotificationBell';
import { useLiveRefresh } from '../lib/live';

// The Overview comes with the workspace; every other section is fetched the
// first time it is opened.
const AdminOrders = lazyScreen(() => import('./AdminOrders').then((m) => m.AdminOrders));
const AdminProblems = lazyScreen(() => import('./AdminProblems').then((m) => m.AdminProblems));
const PaymentsLedger = lazyScreen(() =>
  import('./reports/PaymentsLedger').then((m) => m.PaymentsLedger),
);
const Commissions = lazyScreen(() => import('./reports/Commissions').then((m) => m.Commissions));
const Reports = lazyScreen(() => import('./reports/Reports').then((m) => m.Reports));
const AdminSetup = lazyScreen(() => import('./AdminSetup').then((m) => m.AdminSetup));
const AdminMember = lazyScreen(() => import('./AdminMember').then((m) => m.AdminMember));
const AdminOrder = lazyScreen(() => import('./AdminOrder').then((m) => m.AdminOrder));
const AuditLog = lazyScreen(() => import('./AuditLog').then((m) => m.AuditLog));
const AdminErrors = lazyScreen(() => import('./AdminErrors').then((m) => m.AdminErrors));
const AdminStart = lazyScreen(() => import('./AdminStart').then((m) => m.AdminStart));
const ZReportPage = lazyScreen(() => import('./reports/ZReport').then((m) => m.ZReportPage));

const NAV = [
  [Rocket, 'Get started', 'start'],
  [LayoutDashboard, 'Overview', ''],
  [BarChart3, 'Reports', 'reports'],
  [ClipboardList, 'Orders', 'orders'],
  [TriangleAlert, 'Problems', 'problems'],
  [HandCoins, 'Payments ledger', 'payments'],
  [CircleDollarSign, 'Commissions', 'commissions'],
  [Users, 'Team', 'team'],
  [History, 'Audit log', 'audit'],
  [Bug, 'Errors', 'errors'],
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
  const [openErrors, setOpenErrors] = useState(0);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [version, setVersion] = useState(0);
  // The Problems and Errors counts in the menu and how far setup has got;
  // the Overview loads its own figures.
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const [issues, errors, setup] = await Promise.all([
        Parse.Cloud.run('adminListIssues', { state: 'open' }) as Promise<{ open: number }>,
        Parse.Cloud.run('adminListErrors', { countOnly: true }) as Promise<{ open: number }>,
        Parse.Cloud.run('getSetupProgress') as Promise<SetupProgress>,
      ]);
      setOpenIssues(issues.open);
      setOpenErrors(errors.open);
      setProgress(setup);
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
        <BrandMark onDark className="admin-brand" logo={restaurantLogo} name={restaurantName} />
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
          {NAV.filter(
            ([, label]) =>
              label !== 'Get started' ||
              section === label ||
              (!preview && progress !== null && !progress.finished),
          ).map(([Icon, label]) => (
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
              {label === 'Errors' && openErrors > 0 && (
                <span className="nav-count">{openErrors}</span>
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
            {progress && !progress.finished && !preview && (
              <div className="setup-notice start-notice">
                <span>
                  <b>Get your restaurant ready:</b> {stepsDone(progress)} of {STEP_COUNT} steps
                  done.{' '}
                  {progress.complete
                    ? 'Everything needed to take orders is set up.'
                    : 'Add your menu and your team so orders can start.'}
                </span>
                <button onClick={() => setSection('Get started')}>
                  {progress.complete ? 'Review' : 'Continue setup'}
                </button>
              </div>
            )}
            {restaurantNameSet === false && !preview && progress?.finished && (
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
        <Suspense fallback={<p className="section-loading">Loading…</p>}>
          {section === 'Get started' &&
            (preview ? (
              <p className="info-card">Sign in as the owner to set up the restaurant.</p>
            ) : (
              <AdminStart onChanged={() => void load()} goTo={(label) => setSection(label)} />
            ))}
          {preview &&
          [
            'Reports',
            'Orders',
            'Problems',
            'Payments ledger',
            'Commissions',
            'Audit log',
            'Errors',
          ].includes(section) ? (
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
              {section === 'Errors' && <AdminErrors onChanged={() => void load()} />}
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
        </Suspense>
      </section>
    </main>
  );
}
