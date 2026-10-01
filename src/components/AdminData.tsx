import { useState } from 'react';
import { Download, ShieldCheck, Upload } from 'lucide-react';
import Parse from '../parse';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';
import { toCsv } from '../lib/csv';
import { useCloud } from './reports/common';

type Row = Record<string, unknown>;
type Summary = { classes: string[]; counts: Record<string, number> };

const LABELS: Record<string, string> = {
  Configuration: 'Settings',
  _User: 'Team',
  MenuCategory: 'Menu categories',
  MenuItem: 'Dishes',
  Accompaniment: 'Accompaniments',
  Customer: 'Customers',
  Order: 'Orders',
  OrderItem: 'Order lines',
  CashHandover: 'Cash handovers',
  TillPayout: 'Till payouts',
  Shift: 'Shifts',
  ZReport: 'Z-reports',
  AuditLog: 'Audit log',
};
const RETENTION = [
  [0, 'Keep them'],
  [6, '6 months'],
  [12, '12 months'],
  [24, '2 years'],
  [36, '3 years'],
] as const;

function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportClass(className: string) {
  const rows: Row[] = [];
  let after: string | null = null;
  do {
    const page: { rows: Row[]; next: string | null } = await Parse.Cloud.run('adminExportData', {
      className,
      after,
    });
    rows.push(...page.rows);
    after = page.next;
  } while (after);
  return rows;
}

// Dates arrive as ISO strings (createdAt) or { __type: 'Date', iso }.
const when = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'iso' in value
      ? String((value as { iso: string }).iso)
      : '';
const pointerId = (value: unknown) =>
  value && typeof value === 'object' && 'objectId' in value
    ? String((value as { objectId: string }).objectId)
    : '';

export function AdminData() {
  const { timezone } = useConfig();
  // 2026-09-28: file names that sort by date.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const summary = useCloud<Summary>('adminExportSummary', {});
  const setup = useCloud<{ settings: Row | null }>('adminListSetup', {});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const local = (value: unknown) => {
    const at = when(value);
    return at
      ? formatDate(at, timezone, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '';
  };

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError('');
    setDone('');
    try {
      await work();
      setDone(`${label}: downloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download');
    } finally {
      setBusy('');
    }
  };

  const backup = () =>
    run('Full backup', async () => {
      const classes: Record<string, Row[]> = {};
      for (const className of summary.data?.classes || Object.keys(LABELS)) {
        setBusy(`Full backup: ${LABELS[className] || className}…`);
        classes[className] = await exportClass(className);
      }
      saveFile(
        `relay-backup-${today}.json`,
        JSON.stringify(
          { app: 'Relay', format: 1, exportedAt: new Date().toISOString(), classes },
          null,
          1,
        ),
        'application/json',
      );
    });

  const ordersCsv = () =>
    run('Orders spreadsheet', async () => {
      const [orders, team] = await Promise.all([exportClass('Order'), exportClass('_User')]);
      const people = new Map(
        team.map((u) => [
          String(u.objectId),
          [u.riderCode || u.cashierCode || u.financeCode, u.name || u.username]
            .filter(Boolean)
            .join(' · '),
        ]),
      );
      orders.sort((a, b) => when(a.createdAt).localeCompare(when(b.createdAt)));
      saveFile(
        `relay-orders-${today}.csv`,
        toCsv(
          [
            'Order',
            'Placed',
            'Type',
            'Channel',
            'Status',
            'Customer',
            'Phone',
            'Address',
            'Subtotal',
            'Delivery fee',
            'Total',
            'Payment',
            'Mobile money ref',
            'Cash status',
            'Taken by',
            'Delivered / completed',
          ],
          orders.map((o) => [
            String(o.orderCode || ''),
            local(o.createdAt),
            String(o.orderType || 'delivery'),
            String(o.channel || ''),
            String(o.status || ''),
            String(o.customerName || ''),
            String(o.customerPhone || ''),
            String(o.deliveryAddress || ''),
            Number(o.subtotal || 0),
            Number(o.deliveryFee || 0),
            Number(o.total || 0),
            String(o.paymentMethod || ''),
            String(o.paymentReference || ''),
            String(o.cashStatus || ''),
            people.get(pointerId(o.createdBy)) || people.get(pointerId(o.placedBy)) || '',
            local(o.deliveredAt),
          ]),
        ),
        'text/csv',
      );
    });

  const customersCsv = () =>
    run('Customers spreadsheet', async () => {
      const customers = await exportClass('Customer');
      customers.sort((a, b) => Number(b.orderCount || 0) - Number(a.orderCount || 0));
      saveFile(
        `relay-customers-${today}.csv`,
        toCsv(
          ['Name', 'Phone', 'Orders', 'Last order', 'Addresses'],
          customers.map((c) => [
            String(c.name || ''),
            String(c.phone || ''),
            Number(c.orderCount || 0),
            local(c.lastOrderAt),
            ((c.addresses as { text: string }[]) || []).map((a) => a.text).join(' | '),
          ]),
        ),
        'text/csv',
      );
    });

  const counts = summary.data?.counts || {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    <div className="data-page">
      <section className="admin-panel">
        <div className="panel-title">
          <h2>Backups and exports</h2>
        </div>
        <p className="muted small">
          A full backup is one file with every record: settings, team (without PINs), menu,
          customers, orders, cash, shifts, Z-reports and the audit log. Keep a copy somewhere safe,
          for example once a week. The spreadsheets open in Excel or Google Sheets.
        </p>
        {summary.data && (
          <p className="small">
            {total.toLocaleString()} records:{' '}
            {summary.data.classes
              .filter((name) => counts[name])
              .map((name) => `${counts[name].toLocaleString()} ${LABELS[name] || name}`)
              .join(' · ')}
          </p>
        )}
        <div className="data-actions">
          <button className="setup-submit" disabled={!!busy} onClick={() => void backup()}>
            <Download aria-hidden /> Full backup (.json)
          </button>
          <button className="setup-secondary" disabled={!!busy} onClick={() => void ordersCsv()}>
            Orders (.csv)
          </button>
          <button className="setup-secondary" disabled={!!busy} onClick={() => void customersCsv()}>
            Customers (.csv)
          </button>
        </div>
        {busy && <p className="muted small">{busy}</p>}
        {done && <p className="setup-notice">{done}</p>}
        {error && <p className="ops-error">{error}</p>}
        <p className="muted small">
          Back4App also keeps its own copies of the database on paid plans (Back4App dashboard →
          your app → Database → Backups).
        </p>
      </section>
      <RestoreBackup onRestored={summary.reload} />
      {setup.data && (
        <PrivacySettings
          key={JSON.stringify(setup.data.settings)}
          settings={setup.data.settings || {}}
          onSaved={setup.reload}
        />
      )}
      {setup.error && <p className="ops-error">{setup.error}</p>}
      <ForgetCustomer />
    </div>
  );
}

type Retention = { orders: number; customers: number; notifications: number; cutoff?: string };

function PrivacySettings({ settings, onSaved }: { settings: Row; onSaved: () => void }) {
  const { timezone } = useConfig();
  const [contact, setContact] = useState(String(settings.privacyContact || ''));
  const [months, setMonths] = useState(Number(settings.retentionMonths || 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [check, setCheck] = useState<Retention | null>(null);
  const saved = Number(settings.retentionMonths || 0);
  const call = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>
          <ShieldCheck aria-hidden className="inline-icon" /> Customer privacy
        </h2>
      </div>
      <p className="muted small">
        Customers’ names, phone numbers, addresses and map pins are personal data. The{' '}
        <a href="/privacy" target="_blank" rel="noreferrer">
          privacy notice
        </a>{' '}
        (linked from the sign-in screen) tells customers and staff what RelayEats keeps and who to
        ask about it.
      </p>
      <form
        className="setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void call(async () => {
            await Parse.Cloud.run('adminSavePrivacy', {
              privacyContact: contact,
              retentionMonths: months,
            });
            setCheck(null);
            setNotice('Saved.');
            onSaved();
          });
        }}
      >
        <label className="setup-field">
          Who customers contact about their details
          <input
            value={contact}
            maxLength={200}
            placeholder="e.g. privacy@mamarose.ug or 0700 000000"
            onChange={(e) => setContact(e.target.value)}
          />
        </label>
        <label className="setup-field">
          Remove customer details from finished orders after
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {RETENTION.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="setup-submit" disabled={busy}>
          Save
        </button>
      </form>
      <p className="muted small">
        Removal happens every night with the cash check: names, phones, addresses and pins go;
        amounts, dishes and payments stay for the books. Orders still being delivered or settled
        keep their details until they are done.
      </p>
      {saved > 0 && (
        <div className="data-actions">
          <button
            className="setup-secondary"
            disabled={busy}
            onClick={() =>
              void call(async () =>
                setCheck(await Parse.Cloud.run('adminApplyRetention', { dryRun: true })),
              )
            }
          >
            Check what would be removed now
          </button>
        </div>
      )}
      {check && (
        <div className="setup-notice data-check">
          <span>
            Details older than {formatDate(check.cutoff || null, timezone, { dateStyle: 'medium' })}
            : {check.orders} orders, {check.customers} saved customers, {check.notifications} old
            notifications.
          </span>
          {check.orders + check.customers + check.notifications > 0 && (
            <button
              disabled={busy}
              onClick={() =>
                void call(async () => {
                  const result: Retention = await Parse.Cloud.run('adminApplyRetention', {});
                  setCheck(null);
                  setNotice(
                    `Removed details from ${result.orders} orders and ${result.customers} saved customers.`,
                  );
                })
              }
            >
              Remove now
            </button>
          )}
        </div>
      )}
      {notice && <p className="setup-notice">{notice}</p>}
      {error && <p className="ops-error">{error}</p>}
    </section>
  );
}

type Forget = { found: boolean; name: string; orders: number; inProgress: number };

function ForgetCustomer() {
  const [phone, setPhone] = useState('');
  const [check, setCheck] = useState<Forget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const call = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result: Forget = await Parse.Cloud.run('adminForgetCustomer', { phone, dryRun });
      if (dryRun) setCheck(result);
      else {
        setCheck(null);
        setPhone('');
        setNotice(
          `Done: details removed from ${result.orders} order${result.orders === 1 ? '' : 's'}${
            result.inProgress
              ? `. ${result.inProgress} still in progress keep them until finished; do this again then`
              : ' and the saved customer deleted'
          }.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>A customer asks to be forgotten</h2>
      </div>
      <p className="muted small">
        Removes their name, phone, addresses and pins from every finished order and deletes their
        saved details. The amounts stay. This cannot be undone.
      </p>
      <form
        className="data-forget"
        onSubmit={(e) => {
          e.preventDefault();
          void call(true);
        }}
      >
        <label className="setup-field">
          Their phone number
          <input
            value={phone}
            inputMode="tel"
            placeholder="07…"
            onChange={(e) => {
              setPhone(e.target.value);
              setCheck(null);
            }}
          />
        </label>
        <button className="setup-secondary" disabled={busy || phone.trim().length < 7}>
          Find
        </button>
      </form>
      {check &&
        (check.found ? (
          <div className="setup-notice data-check">
            <span>
              <b>{check.name || 'This customer'}</b>: {check.orders} finished order
              {check.orders === 1 ? '' : 's'}
              {check.inProgress > 0 && `, ${check.inProgress} still in progress`}.
            </span>
            <button disabled={busy} onClick={() => void call(false)}>
              Remove their details
            </button>
          </div>
        ) : (
          <p className="muted small">No customer or order with that phone number.</p>
        ))}
      {notice && <p className="setup-notice">{notice}</p>}
      {error && <p className="ops-error">{error}</p>}
    </section>
  );
}

// The order the server restores in: records a record links to come first
// (cloud/restore.js).
const RESTORE_ORDER = [
  'Configuration',
  '_User',
  'MenuCategory',
  'Accompaniment',
  'MenuItem',
  'Customer',
  'Shift',
  'TillPayout',
  'Order',
  'OrderItem',
  'CashHandover',
  'ZReport',
  'AuditLog',
];
const RESTORE_BATCH = 200;
type Backup = { exportedAt: string; classes: Record<string, Row[]> };
type Pin = { username: string; name: string; role: string; pin: string };
type Outcome = Record<string, { created: number; updated: number; skipped: number }>;

// Owner: put records back from a full backup file. Records still here are
// left as they are; only missing ones come back, linked as before.
function RestoreBackup({ onRestored }: { onRestored: () => void }) {
  const { timezone } = useConfig();
  const [backup, setBackup] = useState<Backup | null>(null);
  const [fileError, setFileError] = useState('');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);

  const read = async (file: File | undefined) => {
    setBackup(null);
    setOutcome(null);
    setPins([]);
    setSure(false);
    setError('');
    setFileError('');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== 'Relay' || !data.classes || typeof data.classes !== 'object')
        throw new Error('This is not a RelayEats backup file.');
      setBackup({ exportedAt: String(data.exportedAt || ''), classes: data.classes });
    } catch (e) {
      setFileError(
        e instanceof SyntaxError
          ? 'This file is not a RelayEats backup (.json).'
          : String((e as Error).message),
      );
    }
  };

  const restore = async () => {
    if (!backup) return;
    setError('');
    setOutcome(null);
    setPins([]);
    const done: Outcome = {};
    const newPins: Pin[] = [];
    try {
      for (const className of RESTORE_ORDER) {
        const rows = Array.isArray(backup.classes[className]) ? backup.classes[className] : [];
        const total = { created: 0, updated: 0, skipped: 0 };
        for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
          setBusy(
            `Restoring ${LABELS[className] || className}: ${Math.min(i + RESTORE_BATCH, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`,
          );
          const part = await Parse.Cloud.run('adminRestoreData', {
            className,
            rows: rows.slice(i, i + RESTORE_BATCH),
          });
          total.created += part.created;
          total.updated += part.updated;
          total.skipped += part.skipped;
          newPins.push(...(part.pins || []));
        }
        done[className] = total;
      }
      setBusy('Linking records and applying the access rules…');
      const counts = Object.fromEntries(
        Object.entries(done).map(([name, t]) => [name, t.created + t.updated]),
      );
      for (let step = 0; step < 1000; step += 1) {
        const result = await Parse.Cloud.run('adminRestoreFinish', { counts });
        if (result.done) break;
      }
      setOutcome(done);
      setPins(newPins);
      onRestored();
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : 'The restore stopped'}. Nothing restored so far is lost; run the restore again with the same file to continue.`,
      );
      setOutcome(done);
      setPins(newPins);
    } finally {
      setBusy('');
    }
  };

  const counts = backup
    ? RESTORE_ORDER.filter((name) => backup.classes[name]?.length).map(
        (name) => `${backup.classes[name].length.toLocaleString()} ${LABELS[name] || name}`,
      )
    : [];
  const restoredTotal = outcome
    ? Object.values(outcome).reduce((n, t) => n + t.created + t.updated, 0)
    : 0;
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>Restore from a backup</h2>
      </div>
      <p className="muted small">
        Puts records back from a full backup file (.json) made here. Records that are still here are
        left as they are; only missing ones come back, linked to each other as before, with their
        original dates. Restoring into a new, empty app brings the whole restaurant back. Team
        members who come back get a new PIN each (a backup holds no PINs).
      </p>
      <label className="setup-field restore-file">
        Backup file
        <input
          type="file"
          accept="application/json,.json"
          disabled={!!busy}
          onChange={(e) => void read(e.target.files?.[0])}
        />
      </label>
      {fileError && <p className="ops-error">{fileError}</p>}
      {backup && !outcome && (
        <>
          <p className="small">
            Backup from{' '}
            <b>
              {backup.exportedAt
                ? formatDate(backup.exportedAt, timezone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'an unknown date'}
            </b>
            : {counts.join(' · ') || 'no records'}.
          </p>
          <label className="setup-checkbox">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            Restore missing records from this file. Settings are replaced only if the backup comes
            from another app.
          </label>
          <div className="data-actions">
            <button
              className="setup-submit"
              disabled={!sure || !!busy}
              onClick={() => void restore()}
            >
              <Upload aria-hidden /> Restore
            </button>
          </div>
        </>
      )}
      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="ops-error">{error}</p>}
      {outcome && (
        <div className="restore-result">
          <p className="setup-notice">
            {restoredTotal
              ? `Restored ${restoredTotal.toLocaleString()} records.`
              : 'Nothing was missing: every record in the backup is still here.'}
          </p>
          <ul className="small">
            {RESTORE_ORDER.filter((name) => outcome[name]).map((name) => (
              <li key={name}>
                {LABELS[name] || name}: {outcome[name].created + outcome[name].updated} restored,{' '}
                {outcome[name].skipped} already here
              </li>
            ))}
          </ul>
          {pins.length > 0 && (
            <div className="restore-pins">
              <h3>New PINs for restored team members</h3>
              <p className="muted small">
                Shown only now. Give each person their PIN; they can change it under their profile.
              </p>
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>New PIN</th>
                  </tr>
                </thead>
                <tbody>
                  {pins.map((p) => (
                    <tr key={p.username}>
                      <td>{p.name}</td>
                      <td>{p.username}</td>
                      <td>{p.role}</td>
                      <td>
                        <code>{p.pin}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="setup-secondary" onClick={() => window.print()}>
                Print
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
