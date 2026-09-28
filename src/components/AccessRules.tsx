import { useState } from 'react';
import { useAdminRun } from '../lib/adminRun';

// Who can do what (enforced on the server, see e2e "permission matrix"), and
// the button that re-applies the database permissions after a deployment.
const RULES: [string, string, string, string][] = [
  ['Take orders, deliver, collect cash, hand it over', 'Yes', 'Counter orders', 'Yes'],
  ['Kitchen board, stock, mobile money checks', '—', 'Yes', 'Yes'],
  ['Count cash handovers, pay riders, till payouts', '—', 'Yes', 'Yes'],
  ['Reports, orders, problems, ledgers, commissions', 'Own earnings', 'Payments ledger', 'Yes'],
  ['Team, menu, get started', '—', '—', 'Yes'],
  [
    'Admin: settings, branding, payment keys, audit log, errors, data & privacy',
    '—',
    '—',
    'With PIN',
  ],
];

export function AccessRules() {
  const adminRun = useAdminRun();
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
        </p>
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>What</th>
                <th>Rider</th>
                <th>Cashier</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {RULES.map(([what, rider, cashier, owner]) => (
                <tr key={what}>
                  <td data-label="What">{what}</td>
                  <td data-label="Rider">{rider}</td>
                  <td data-label="Cashier">{cashier}</td>
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
    </div>
  );
}
