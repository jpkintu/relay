import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { LockKeyhole, Lock } from 'lucide-react';
import Parse from '../parse';
import { lazyScreen } from '../lib/lazy';
import { useConfig, useSession } from '../lib/session';
import { formatDate } from '../lib/format';
import { ADMIN_TABS, type AdminTab } from '../lib/adminTabs';

const AdminSetup = lazyScreen(() => import('./AdminSetup').then((m) => m.AdminSetup));
const AdminPayments = lazyScreen(() => import('./AdminPayments').then((m) => m.AdminPayments));
const AdminEfris = lazyScreen(() => import('./AdminEfris').then((m) => m.AdminEfris));
const AdminWhatsApp = lazyScreen(() => import('./AdminWhatsApp').then((m) => m.AdminWhatsApp));
const AccessRules = lazyScreen(() => import('./AccessRules').then((m) => m.AccessRules));
const AuditLog = lazyScreen(() => import('./AuditLog').then((m) => m.AuditLog));
const AdminErrors = lazyScreen(() => import('./AdminErrors').then((m) => m.AdminErrors));
const AdminData = lazyScreen(() => import('./AdminData').then((m) => m.AdminData));

type Unlock = { unlocked: boolean; until: string | null; minutes: number };

// Admin: the restaurant's configuration and records, behind the owner's PIN.
// The server keeps it open for 15 minutes from the last use on this device.
export function AdminSite({
  tab,
  onTab,
  openErrors,
  onChanged,
}: {
  tab: AdminTab;
  onTab: (tab: AdminTab) => void;
  openErrors: number;
  onChanged: () => void;
}) {
  // Relay Hosted plans may leave some pages out.
  const features = useSession().profile?.features;
  const { timezone } = useConfig();
  const [state, setState] = useState<Unlock | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    try {
      setState(await Parse.Cloud.run('getAdminUnlock'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check');
    }
  }, []);
  // Checked on opening and on each tab, so an expired unlock asks again.
  useEffect(() => {
    void check();
  }, [check, tab]);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await Parse.Cloud.run('unlockAdmin', { pin }));
      setPin('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p className="section-loading">Loading…</p>;
  if (!state.unlocked)
    return (
      <form className="admin-gate admin-panel" onSubmit={(e) => void unlock(e)}>
        <LockKeyhole aria-hidden className="admin-gate-icon" />
        <h2>Admin is locked</h2>
        <p className="muted">
          Settings, branding, payment and tax keys, access rules, the audit log, errors and customer
          data need your PIN again. Admin stays open for {state.minutes} minutes after you last use
          it.
        </p>
        <label className="setup-field">
          Your PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        {error && <p className="ops-error">{error}</p>}
        <button className="setup-submit" disabled={busy || !pin}>
          {busy ? 'Checking…' : 'Open Admin'}
        </button>
      </form>
    );

  return (
    <div className="admin-site">
      <div className="admin-site-bar">
        <nav className="admin-tabs" aria-label="Admin pages">
          {ADMIN_TABS.filter(
            ([id]) =>
              (id !== 'tax' || features?.efris !== false) &&
              (id !== 'whatsapp' || features?.whatsapp !== false),
          ).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => onTab(id)}
            >
              {label}
              {id === 'errors' && openErrors > 0 && <span className="nav-count">{openErrors}</span>}
            </button>
          ))}
        </nav>
        <button
          className="setup-secondary admin-lock"
          onClick={async () => {
            await Parse.Cloud.run('lockAdmin').catch(() => undefined);
            await check();
          }}
        >
          <Lock aria-hidden /> Lock
        </button>
      </div>
      {state.until && (
        <p className="muted small">
          Open until {formatDate(state.until, timezone, { timeStyle: 'short' })}, longer while you
          use it.
        </p>
      )}
      <Suspense fallback={<p className="section-loading">Loading…</p>}>
        {tab === 'settings' && <AdminSetup section="Settings" preview={false} />}
        {tab === 'branding' && <AdminSetup section="Branding" preview={false} />}
        {tab === 'payments' && <AdminPayments />}
        {tab === 'tax' && <AdminEfris />}
        {tab === 'whatsapp' && <AdminWhatsApp />}
        {tab === 'access' && <AccessRules />}
        {tab === 'audit' && <AuditLog />}
        {tab === 'errors' && <AdminErrors onChanged={onChanged} />}
        {tab === 'data' && <AdminData />}
      </Suspense>
    </div>
  );
}
