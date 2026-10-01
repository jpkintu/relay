import { useEffect, useState } from 'react';
import { useAdminRun } from '../lib/adminRun';
import { useSession } from '../lib/session';

// Who can do what (enforced on the server, see e2e "permission matrix"), and
// the button that re-applies the database permissions after a deployment.
const RULES: [string, string, string, string, string][] = [
  // What, rider, cashier, finance, owner
  ['Take orders, deliver, collect cash, hand it over', 'Yes', 'Counter orders', '—', 'Yes'],
  ['Kitchen board, stock, mobile money checks', '—', 'Yes', '—', 'Yes'],
  ['Count cash handovers, pay riders, till payouts', '—', 'Yes', '—', 'Yes'],
  ['Overview, reports, Z-report', '—', '—', 'Yes', 'Yes'],
  ['Orders, payments ledger, commissions', 'Own earnings', 'Payments ledger', 'View only', 'Yes'],
  ['Purchases, expenses, suppliers, customers', '—', '—', 'Yes', 'Yes'],
  ['Accounting statements, tax receipts (EFRIS)', '—', '—', 'Yes', 'Yes'],
  ['Problems, team, branches, menu, get started', '—', '—', '—', 'Yes'],
  [
    'Admin: settings, branding, payment keys, audit log, errors, data & privacy',
    '—',
    '—',
    '—',
    'With PIN',
  ],
];

// Riders and cashiers work at one branch and see only its orders and cash;
// the owner and finance see every branch.

export function AccessRules() {
  const adminRun = useAdminRun();
  const features = useSession().profile?.features;
  const finance = features?.finance !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  return (
    <div className="data-page">
      <section className="admin-panel">
        <div className="panel-title">
          <h2>Who can do what</h2>
        </div>
        <p className="muted small">
          Each person has one role. The server checks the role on every action, whatever the app
          shows, and the Admin area also needs the owner’s PIN again (it closes after 15 minutes
          unused).
          {features?.branches !== false &&
            ' Riders and cashiers work at one branch and see only its orders and cash; finance and the owner see every branch.'}
        </p>
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>What</th>
                <th>Rider</th>
                <th>Cashier</th>
                {finance && <th>Finance</th>}
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {RULES.map(([what, rider, cashier, fin, owner]) => (
                <tr key={what}>
                  <td data-label="What">{what}</td>
                  <td data-label="Rider">{rider}</td>
                  <td data-label="Cashier">{cashier}</td>
                  {finance && <td data-label="Finance">{fin}</td>}
                  <td data-label="Owner">{owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="admin-panel">
        <div className="panel-title">
          <h2>Apply security rules</h2>
        </div>
        <p className="muted small">
          Re-applies database permissions, adds new fields and assigns missing rider and cashier
          codes. Run it once after each deployment that changes Cloud Code; it is safe to run again.
        </p>
        <button
          className="setup-submit"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            setResult('');
            try {
              await adminRun('adminApplySecurity');
              setResult('Security rules applied.');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not apply');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Applying…' : 'Apply security rules'}
        </button>
        {result && <p className="setup-notice">{result}</p>}
        {error && <p className="ops-error">{error}</p>}
      </section>
      <SignInProtection />
    </div>
  );
}

type SecurityStatus = {
  known: boolean;
  lockout: { threshold: number; minutes: number } | null;
  serverSessionDays: number | null;
  staffDays: number;
  ownerDays: number;
};

// Whether the server locks an account after wrong PINs (S5) and how long a
// sign-in lasts (S7). The lockout is a Back4App setting the owner turns on.
function SignInProtection() {
  const adminRun = useAdminRun();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  useEffect(() => {
    adminRun('adminSecurityStatus')
      .then((s) => setStatus(s as SecurityStatus))
      .catch(() => setStatus(null));
  }, [adminRun]);
  if (!status) return null;
  const lockoutOn = !!status.lockout;
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>Sign-in protection</h2>
      </div>
      <ul className="security-status">
        <li className={lockoutOn ? 'ok' : 'bad'}>
          <b>Wrong PINs lock the account:</b>{' '}
          {lockoutOn
            ? `on (${status.lockout!.threshold} wrong PINs lock it for ${status.lockout!.minutes} minutes; unlock someone from Team).`
            : 'off. Anyone could keep guessing a 4-digit PIN. Turn it on in Back4App (below).'}
        </li>
        <li className="ok">
          <b>Sign-ins end after:</b> {status.staffDays} days for riders and cashiers,{' '}
          {status.ownerDays} days for the owner and finance.
        </li>
      </ul>
      {!lockoutOn && (
        <p className="muted small">
          Back4App → your app → Server Settings → Custom Parse Options, add{' '}
          <code>
            {'{"accountLockout": {"threshold": 5, "duration": 15}, "sessionLength": 2592000}'}
          </code>{' '}
          and save. Then reload this page.
        </p>
      )}
    </section>
  );
}
