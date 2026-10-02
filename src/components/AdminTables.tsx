import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Plus, Printer, RefreshCw } from 'lucide-react';
import Parse from '../parse';
import { useAdminRun } from '../lib/adminRun';
import { useSession } from '../lib/session';
import { printDocument } from '../lib/print';
import { flierCss, tableCardsHtml } from '../lib/flier';

// Admin → Online orders → Tables: the restaurant's tables, each with its own
// QR code (tables.js). Guests scan the card on their table and order; the
// order goes to the kitchen for that table and is paid later.

type Table = { id: string; name: string; branchId: string; active: boolean; token: string };
type Branch = { id: string; name: string };

const qrOf = (url: string) =>
  QRCode.toDataURL(url, {
    margin: 1,
    width: 700,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1633', light: '#ffffff' },
  });

export function AdminTables({ link }: { link: string }) {
  const adminRun = useAdminRun();
  const { config } = useSession();
  const [tables, setTables] = useState<Table[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const tableLink = useCallback((t: Table) => `${link}/table/${t.token}`, [link]);

  const load = useCallback(
    () =>
      adminRun<{ tables: Table[] }>('adminListTables')
        .then((r) => setTables(r.tables))
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the tables')),
    [adminRun],
  );
  useEffect(() => {
    void load();
    Parse.Cloud.run('getBranches')
      .then((r: { branches: Branch[] }) => setBranches(r.branches))
      .catch(() => setBranches([]));
  }, [load]);

  const save = async (params: Record<string, unknown>, message: string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await adminRun('adminSaveTable', params);
      await load();
      setDone(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the table');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const next = name.trim();
    if (
      await save(
        { name: next, ...(branchId && { branchId }) },
        `${next} added. Print its card below.`,
      )
    )
      setName(/\d+$/.test(next) ? next.replace(/\d+$/, (n) => String(Number(n) + 1)) : '');
  };

  const print = async (list: Table[]) => {
    try {
      const cards = await Promise.all(
        list.map(async (t) => ({ name: t.name, qr: await qrOf(tableLink(t)) })),
      );
      await printDocument(
        `${config.restaurantName} table cards`,
        flierCss({
          size: 'cards',
          ink: config.theme?.ink || '',
          accent: config.theme?.accent || '',
        }),
        tableCardsHtml(
          {
            restaurant: config.restaurantName,
            logo: config.restaurantLogo || '',
            subline: 'Scan to order. Pay when you’re done.',
            modes: '',
            payments: '',
            note: '',
            ink: config.theme?.ink || '',
            accent: config.theme?.accent || '',
          },
          cards,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not print');
    }
  };

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || '';
  const open = (tables || []).filter((t) => t.active);

  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>Tables</h2>
          <p className="muted">
            Each table gets its own QR code. Guests scan the card on their table, order without
            signing in, and the order reaches the kitchen board for that table. They pay at the end
            like any open bill; the board can move an order to another table.
          </p>
        </div>
        {open.length > 0 && (
          <button className="primary-button" onClick={() => void print(open)}>
            <Printer aria-hidden /> Print all cards
          </button>
        )}
      </div>
      <form
        className="tables-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="setup-field">
          Table
          <input
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Table 1, Terrace 2"
          />
        </label>
        {branches.length > 1 && (
          <label className="setup-field">
            Branch
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Main branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="setup-secondary" disabled={busy || !name.trim()}>
          <Plus aria-hidden /> Add table
        </button>
      </form>
      {error && <p className="ops-error">{error}</p>}
      {done && <p className="form-success">{done}</p>}
      {tables === null ? (
        <p className="section-loading">Loading…</p>
      ) : !tables.length ? (
        <p className="muted">No tables yet. Add them above, then print their cards.</p>
      ) : (
        <div className="table-scroll">
          <table className="data stack-on-phone">
            <thead>
              <tr>
                <th>Table</th>
                {branches.length > 1 && <th>Branch</th>}
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'inactive'}>
                  <td data-label="Table">
                    <b>{t.name}</b>
                  </td>
                  {branches.length > 1 && <td data-label="Branch">{branchName(t.branchId)}</td>}
                  <td data-label="Status">
                    <span className={`status-pill ${t.active ? 'good' : 'bad'}`}>
                      {t.active ? 'Taking orders' : 'Closed'}
                    </span>
                  </td>
                  <td className="actions-cell">
                    {t.active && (
                      <button className="setup-secondary" onClick={() => void print([t])}>
                        <Printer aria-hidden /> Card
                      </button>
                    )}
                    <button
                      className="setup-secondary"
                      disabled={busy}
                      onClick={() => {
                        const next = window.prompt('Table name', t.name);
                        if (next && next.trim() !== t.name)
                          void save({ id: t.id, name: next.trim() }, 'Renamed.');
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="setup-secondary"
                      disabled={busy}
                      title="Make a new QR code; the old card stops working"
                      onClick={() => {
                        if (
                          window.confirm(
                            `New QR code for ${t.name}? Its current card stops working: print the new one.`,
                          )
                        )
                          void save(
                            { id: t.id, name: t.name, newCode: true },
                            `New code for ${t.name}. Print its card.`,
                          );
                      }}
                    >
                      <RefreshCw aria-hidden /> New code
                    </button>
                    <button
                      className="setup-secondary"
                      disabled={busy}
                      onClick={() =>
                        void save(
                          { id: t.id, name: t.name, active: !t.active },
                          t.active ? `${t.name} closed.` : `${t.name} reopened.`,
                        )
                      }
                    >
                      {t.active ? 'Close' : 'Reopen'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
