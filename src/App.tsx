import { Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import Parse from './parse';
import { AuthScreen } from './components/AuthScreen';
import { BrandMark } from './components/BrandMark';
import { lazyScreen } from './lib/lazy';
import { SessionProvider, homePath, useSession } from './lib/session';
import type { Role } from './lib/session';
import { useDeviceAttribute } from './lib/device';
import { NotificationsProvider } from './lib/notifications';
import { PinProvider } from './lib/pin';
import { useOnline } from './lib/online';
import { OfflineBanner } from './components/InstallPrompt';
import { ClosedScreen, SubscriptionBanner } from './components/Subscription';

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}

// Each workspace is its own download: a rider's phone never fetches the
// owner's reports or the kitchen board.
const loadRider = () => import('./components/RiderWorkspace').then((m) => m.RiderWorkspace);
const loadCashier = () => import('./components/CashierWorkspace').then((m) => m.CashierWorkspace);
const loadAdmin = () => import('./components/AdminWorkspace').then((m) => m.AdminWorkspace);
const RiderWorkspace = lazyScreen(loadRider);
const CashierWorkspace = lazyScreen(loadCashier);
const AdminWorkspace = lazyScreen(loadAdmin);
const PlatformConsole = lazyScreen(() =>
  import('./components/PlatformConsole').then((m) => m.PlatformConsole),
);
const PrivacyPage = lazyScreen(() => import('./components/PrivacyPage').then((m) => m.PrivacyPage));
// Started as soon as the role is known, alongside the profile's other requests.
const PRELOAD: Record<Role, () => Promise<unknown>> = {
  rider: loadRider,
  cashier: loadCashier,
  admin: loadAdmin,
};

// Which roles may open each workspace. Admins can also run the kitchen board.
const ACCESS: Record<string, Role[]> = {
  rider: ['rider'],
  cashier: ['cashier', 'admin'],
  admin: ['admin'],
};

function AppRoutes() {
  const online = useOnline();
  return (
    <>
      <OfflineBanner online={online} />
      <AppScreens />
    </>
  );
}

function AppScreens() {
  useDeviceAttribute();
  const session = useSession();
  const { user, profile, preview, status } = session;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // After signing in, everyone starts on their home page: riders on Home,
  // cashiers on the kitchen board, the owner on the Overview. A reload with a
  // live session keeps the page (and links from notifications still work).
  const freshSignIn = useRef(!user);
  const role = profile?.role ?? null;
  useEffect(() => {
    if (role) void PRELOAD[role]().catch(() => undefined);
  }, [role]);
  useEffect(() => {
    if (!user) freshSignIn.current = true;
    else if (role && freshSignIn.current) {
      freshSignIn.current = false;
      navigate(homePath(role), { replace: true });
    }
  }, [user, role, navigate]);

  // The privacy notice is open to everyone, signed in or not.
  if (pathname === '/privacy')
    return (
      <Suspense fallback={<Splash />}>
        <PrivacyPage />
      </Suspense>
    );
  if (preview) return <PreviewApp />;
  if (!user) return <AuthScreen />;
  if (status === 'loading' && !profile) return <Splash />;
  if (!profile) return <AccountProblem />;
  // Relay Hosted: Relay's own staff, and restaurants that must renew first.
  if (profile.platform)
    return (
      <Suspense fallback={<Splash />}>
        <PlatformConsole />
      </Suspense>
    );
  if (profile.restaurant && !profile.restaurant.usable) return <ClosedScreen />;
  if (!profile.role) return <NoRole />;

  const myRole = profile.role;
  const guard = (area: keyof typeof ACCESS, element: ReactNode) =>
    ACCESS[area].includes(myRole) ? element : <Navigate to={homePath(myRole)} replace />;
  return (
    <NotificationsProvider>
      <PinProvider>
        <SubscriptionBanner />
        <Suspense fallback={<Splash />}>
          <Routes>
            <Route path="/rider/*" element={guard('rider', <RiderWorkspace />)} />
            <Route path="/cashier/*" element={guard('cashier', <CashierWorkspace />)} />
            <Route path="/admin/*" element={guard('admin', <AdminWorkspace />)} />
            <Route path="*" element={<Navigate to={homePath(myRole)} replace />} />
          </Routes>
        </Suspense>
      </PinProvider>
    </NotificationsProvider>
  );
}

function PreviewApp() {
  const { logout } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const current = (['rider', 'cashier', 'admin'] as Role[]).find((r) =>
    pathname.startsWith(`/${r}`),
  );
  return (
    <div className="preview-app">
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/rider/*" element={<RiderWorkspace />} />
          <Route path="/cashier/*" element={<CashierWorkspace />} />
          <Route path="/admin/*" element={<AdminWorkspace />} />
          <Route path="*" element={<Navigate to="/rider" replace />} />
        </Routes>
      </Suspense>
      <nav className="role-switch" aria-label="Preview role navigation">
        <strong>LIVE PREVIEW</strong>
        {(['rider', 'cashier', 'admin'] as Role[]).map((role) => (
          <button
            className={current === role ? 'active' : ''}
            onClick={() => navigate(`/${role}`)}
            key={role}
          >
            {role}
          </button>
        ))}
        <button
          className="preview-login"
          onClick={() => {
            void logout();
            navigate('/');
          }}
        >
          Sign in
        </button>
      </nav>
    </div>
  );
}

function Splash() {
  return (
    <main className="splash" aria-busy="true">
      <BrandMark className="brand-lg" />
      <p className="muted">Loading your workspace…</p>
    </main>
  );
}

function AccountProblem() {
  const { error, refresh, logout } = useSession();
  return (
    <CenteredCard title="We couldn't load your account.">
      <p className="form-error">{error || 'Check your connection and try again.'}</p>
      <button className="primary-button" onClick={() => void refresh()}>
        Try again
      </button>
      <button className="preview-button" onClick={() => void logout()}>
        <LogOut size={17} /> Sign out
      </button>
    </CenteredCard>
  );
}

// Signed in, but no role yet: either the very first owner (who can
// initialize the restaurant) or an account the owner has not set up.
function NoRole() {
  const { profile, refresh, logout } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const initialize = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('bootstrapOwner');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to initialize owner');
    } finally {
      setBusy(false);
    }
  };
  return profile?.canInitialize ? (
    <CenteredCard title="Set up your restaurant.">
      <p className="muted">
        This is the first account. Make it the owner to manage the menu, team and settings.
      </p>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" disabled={busy} onClick={() => void initialize()}>
        {busy ? 'Setting up…' : 'Initialize owner'}
      </button>
      <button className="preview-button" onClick={() => void logout()}>
        <LogOut size={17} /> Sign out
      </button>
    </CenteredCard>
  ) : (
    <CenteredCard title="No access yet.">
      <p className="muted">
        Your account ({profile?.username}) has not been given a role. Ask the restaurant
        administrator to add you as a rider or cashier.
      </p>
      <button className="preview-button" onClick={() => void logout()}>
        <LogOut size={17} /> Sign out
      </button>
    </CenteredCard>
  );
}

function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  const { config } = useSession();
  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="login-card">
          <BrandMark className="mobile-brand" />
          <p className="eyebrow">{config.restaurantName}</p>
          <h2>{title}</h2>
          {children}
        </div>
      </section>
    </main>
  );
}
