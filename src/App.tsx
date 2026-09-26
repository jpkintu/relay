import { useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import Parse from './parse';
import { AuthScreen } from './components/AuthScreen';
import { RiderWorkspace } from './components/RiderWorkspace';
import { CashierWorkspace } from './components/CashierWorkspace';
import { AdminWorkspace } from './components/AdminWorkspace';
import { BrandMark } from './components/BrandMark';
import { SessionProvider, homePath, useSession } from './lib/session';
import type { Role } from './lib/session';
import { useDeviceAttribute } from './lib/device';
import { NotificationsProvider } from './lib/notifications';

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}

// Which roles may open each workspace. Admins can also run the kitchen board.
const ACCESS: Record<string, Role[]> = {
  rider: ['rider'],
  cashier: ['cashier', 'admin'],
  admin: ['admin'],
};

function AppRoutes() {
  useDeviceAttribute();
  const session = useSession();
  const { user, profile, preview, status } = session;

  if (preview) return <PreviewApp />;
  if (!user) return <AuthScreen />;
  if (status === 'loading' && !profile) return <Splash />;
  if (!profile) return <AccountProblem />;
  if (!profile.role) return <NoRole />;

  const role = profile.role;
  const guard = (area: keyof typeof ACCESS, element: ReactNode) =>
    ACCESS[area].includes(role) ? element : <Navigate to={homePath(role)} replace />;
  return (
    <NotificationsProvider>
      <Routes>
        <Route path="/rider/*" element={guard('rider', <RiderWorkspace />)} />
        <Route path="/cashier/*" element={guard('cashier', <CashierWorkspace />)} />
        <Route path="/admin/*" element={guard('admin', <AdminWorkspace />)} />
        <Route path="*" element={<Navigate to={homePath(role)} replace />} />
      </Routes>
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
      <Routes>
        <Route path="/rider/*" element={<RiderWorkspace />} />
        <Route path="/cashier/*" element={<CashierWorkspace />} />
        <Route path="/admin/*" element={<AdminWorkspace />} />
        <Route path="*" element={<Navigate to="/rider" replace />} />
      </Routes>
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
