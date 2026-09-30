import { useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import Parse from '../parse';
import { useSession } from '../lib/session';
import { useCloud } from './reports/common';

type Branch = {
  id: string;
  name: string;
  address: string;
  phone: string;
  active: boolean;
  main: boolean;
  members: { riders: number; cashiers: number };
};

type Draft = { id?: string; name: string; address: string; phone: string; active: boolean };

const EMPTY: Draft = { name: '', address: '', phone: '', active: true };

// Owner: the restaurant's branches. Riders and cashiers are given a branch on
// their page (Team); dishes are offered per branch in the menu; reports
// filter by branch.
export function AdminBranches() {
  const { refresh } = useSession();
  const { data, error, loading, reload } = useCloud<{ branches: Branch[] }>(
    'adminListBranches',
    {},
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const branches = data?.branches ?? [];

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setSaveError('');
    try {
      await Parse.Cloud.run('adminSaveBranch', draft);
      setDraft(null);
      reload();
      // The branch count in the profile decides where branch filters show.
      void refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the branch');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={loading ? 'report busy' : 'report'}>
      {error && <p className="ops-error">{error}</p>}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Branches <small>({branches.length})</small>
          </h2>
          <button
            className="setup-secondary branch-add"
            onClick={() => {
              setSaveError('');
              setDraft({ ...EMPTY });
            }}
          >
            <Plus size={16} /> Add a branch
          </button>
        </div>
        <p className="muted small">
          Each rider and cashier works at one branch (set on their page under Team). Cashiers see
          their branch&apos;s kitchen board, payments and stock; the owner and finance see every
          branch, and reports can be filtered by branch. Choose which branches offer each dish in
          the Menu.
        </p>
        {draft && (
          <form
            className="branch-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="setup-field">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Ntinda branch"
                maxLength={60}
                autoFocus
              />
            </label>
            <label className="setup-field">
              Address
              <input
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                placeholder="Street, area or building"
                maxLength={200}
              />
            </label>
            <label className="setup-field">
              Phone
              <input
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                inputMode="tel"
                maxLength={30}
              />
            </label>
            {draft.id && (
              <label className="setup-checkbox">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                />{' '}
                Open (a closed branch takes no orders and keeps its history)
              </label>
            )}
            {saveError && <p className="form-error">{saveError}</p>}
            <div className="payment-actions">
              <button disabled={busy || draft.name.trim().length < 2}>
                {draft.id ? 'Save branch' : 'Add branch'}
              </button>
              <button type="button" className="setup-secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Branch</th>
                <th>Contact</th>
                <th className="num">Riders</th>
                <th className="num">Cashiers</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.id} className={b.active ? '' : 'inactive'}>
                  <td data-label="Branch">
                    <b>{b.name}</b>
                    {b.main && <small>Main branch</small>}
                  </td>
                  <td data-label="Contact">
                    {b.address && (
                      <small>
                        <MapPin size={12} /> {b.address}
                      </small>
                    )}
                    {b.phone && <small>{b.phone}</small>}
                    {!b.address && !b.phone && <small className="muted">—</small>}
                  </td>
                  <td data-label="Riders" className="num">
                    {b.members.riders}
                  </td>
                  <td data-label="Cashiers" className="num">
                    {b.members.cashiers}
                  </td>
                  <td data-label="Status">
                    <span className={`status-pill ${b.active ? 'good' : 'bad'}`}>
                      {b.active ? 'Open' : 'Closed'}
                    </span>
                  </td>
                  <td className="actions-cell">
                    <button
                      className="setup-secondary"
                      onClick={() => {
                        setSaveError('');
                        setDraft({
                          id: b.id,
                          name: b.name,
                          address: b.address,
                          phone: b.phone,
                          active: b.active,
                        });
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!branches.length && !loading && (
                <tr>
                  <td colSpan={6} className="empty-orders">
                    No branches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
