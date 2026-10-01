import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { SignInProtection, type SecurityStatus } from './AccessRules';
import { LogOut, RefreshCw } from 'lucide-react';
import Parse from '../parse';
import { PlatformWhatsApp } from './PlatformWhatsApp';
import { PlatformEmail } from './PlatformEmail';
import { PlatformBroadcast } from './PlatformBroadcast';
import { PlatformRevenue } from './PlatformRevenue';
import { PlatformAccounting } from './PlatformAccounting';
import { PlatformDiscounts } from './PlatformDiscounts';
import { PlatformPlans, type Plan } from './PlatformPlans';
import { formatDate, formatMoney } from '../lib/format';
import { useSession, type RestaurantSummary } from '../lib/session';
import { AdminErrors } from './AdminErrors';
import { BrandMark } from './BrandMark';
import { daysLeft } from './Subscription';
import { printSubscriptionReceipt } from '../lib/subscriptionReceipt';

const loadSecurity = (): Promise<SecurityStatus> => Parse.Cloud.run('platformSecurityStatus');

// Relay Hosted: the platform console for Relay's own staff. Every restaurant's
// subscription and size, never its orders or customers (docs/HOSTED.md).

type Settings = {
  // The plans (prices are on them; see PlatformPlans).
  plans: Plan[];
  currency: string;
  trialDays: number;
  graceDays: number;
  supportContact: string;
  billingFrom: string;
  referralPercent: number;
  referralMonths: number;
  // Restaurants that stopped paying: data deleted this many days after the
  // app closes (0: never), the owner warned this many days before.
  deleteAfterDays: number;
  deleteWarnDays: number;
};
type Row = RestaurantSummary & {
  ownerName: string;
  billingPhone: string;
  priceOverride: number | null;
  suspended: boolean;
  note: string;
  createdAt: string;
  staff: number;
  orders30: number;
  // Data deleted (subscription payments kept), never deleted automatically,
  // or when it will be.
  deleted: boolean;
  deletedAt: string | null;
  deletedCode: string;
  neverDelete: boolean;
  deletion: { closedAt: string; warnedAt: string | null; deleteAt: string } | null;
};
type Change = {
  at: string;
  action: string;
  by: string;
  entityId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

const STATUS: Record<RestaurantSummary['status'], string> = {
  trial: 'Trial',
  active: 'Paid',
  past_due: 'Grace days',
  expired: 'Expired',
  suspended: 'Suspended',
};
type Tab = 'dashboard' | 'accounting' | 'restaurants' | 'plans' | 'messages' | 'settings';
const TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['accounting', 'Accounting'],
  ['restaurants', 'Restaurants'],
  ['plans', 'Plans & codes'],
  ['messages', 'Email & WhatsApp'],
  ['settings', 'Settings & errors'],
];
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (value: string | null) => formatDate(value, TIMEZONE, { dateStyle: 'medium' });
// <input type="date"> works in local days; the server stores the end of that day.
const toInput = (value: string | null) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const endOfDay = (value: string) => (value ? new Date(`${value}T23:59:59`).toISOString() : null);
const message = (e: unknown) => (e instanceof Error ? e.message : 'That did not work');

export function PlatformConsole() {
  const { profile, logout } = useSession();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // What the last deletion did (shown above the list).
  const [deletedNote, setDeletedNote] = useState('');
  const [query, setQuery] = useState('');
  // Console sections, remembered in the address (#restaurants…).
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.slice(1) as Tab;
    return TABS.some(([key]) => key === hash) ? hash : 'dashboard';
  });
  const openTab = (key: Tab) => {
    setTab(key);
    window.history.replaceState(null, '', `#${key}`);
  };
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [list, audit] = await Promise.all([
        Parse.Cloud.run('platformListRestaurants') as Promise<{ rows: Row[]; settings: Settings }>,
        Parse.Cloud.run('platformGetAudit') as Promise<{ rows: Change[] }>,
      ]);
      setRows(list.rows);
      setSettings(list.settings);
      setChanges(audit.rows);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        !q ||
        [r.name, r.code, r.ownerName, r.billingPhone, r.ownerEmail || ''].some((v) =>
          v.toLowerCase().includes(q),
        ),
    );
  }, [rows, query]);
  const current = rows?.find((r) => r.id === selected) || null;
  const currency = settings?.currency || '';
  const names = useMemo(() => new Map((rows || []).map((r) => [r.id, r.name])), [rows]);

  return (
    <div className="platform-console">
      <header className="platform-header">
        <BrandMark />
        <div>
          <strong>Relay platform</strong>
          <small>{profile?.name}</small>
        </div>
        <button className="secondary-button" onClick={() => void load()}>
          <RefreshCw size={16} /> Refresh
        </button>
        <button className="secondary-button" onClick={() => void logout()}>
          <LogOut size={16} /> Sign out
        </button>
      </header>
      <main className="platform-main">
        {error && <p className="form-error">{error}</p>}
        <nav className="platform-tabs" aria-label="Console sections">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => openTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' && (
          <>
            <PlatformRevenue timeZone={TIMEZONE} />
          </>
        )}

        {tab === 'accounting' && <PlatformAccounting timeZone={TIMEZONE} />}

        {tab === 'restaurants' && (
          <>
            <section className="admin-panel">
              <div className="panel-title">
                <h2>Restaurants</h2>
              </div>
              {deletedNote && (
                <p className="form-success" role="status">
                  {deletedNote}
                </p>
              )}
              <input
                className="platform-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, code, owner or phone"
                aria-label="Search restaurants"
              />
              {!rows ? (
                <p className="section-loading">Loading…</p>
              ) : shown.length === 0 ? (
                <p className="muted">No restaurants{query ? ' match' : ' yet'}.</p>
              ) : (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Restaurant</th>
                        <th>Owner</th>
                        <th>Status</th>
                        <th>Until</th>
                        <th className="num">Price</th>
                        <th className="num">Staff</th>
                        <th className="num">Orders (30 days)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr
                          key={r.id}
                          className={`clickable${r.id === selected ? ' selected' : ''}`}
                          tabIndex={0}
                          title="Open the restaurant"
                          onClick={() => setSelected(r.id)}
                          onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)}
                        >
                          <td>
                            <b>{r.name}</b>
                            <small className="cell-sub">{r.code}</small>
                          </td>
                          <td>
                            {r.ownerName}
                            <small className="cell-sub">
                              {[r.billingPhone, r.ownerEmail].filter(Boolean).join(' · ')}
                            </small>
                          </td>
                          <td>
                            <span className={`status-pill status-${r.status}`}>
                              {r.deleted ? 'Data deleted' : STATUS[r.status]}
                            </span>
                            {r.deletion && (
                              <small className="cell-sub danger-text">
                                Deleted on {day(r.deletion.deleteAt)}
                                {r.deletion.warnedAt ? ' · owner warned' : ''}
                              </small>
                            )}
                          </td>
                          <td>
                            {day(r.until)}
                            {r.usable && r.until && (
                              <small className="cell-sub">{daysLeft(r.until)} days left</small>
                            )}
                          </td>
                          <td className="num">
                            {formatMoney(r.monthlyPrice, r.currency)}
                            <small className="cell-sub">
                              {r.planName || r.plan}
                              {r.priceOverride !== null && ' · own price'}
                            </small>
                          </td>
                          <td className="num">{r.staff}</td>
                          <td className="num">{r.orders30}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {current && settings && (
              <RestaurantEditor
                key={current.id}
                row={current}
                settings={settings}
                onSaved={(next) => {
                  setRows((all) => (all || []).map((r) => (r.id === next.id ? next : r)));
                  void load();
                }}
                onClose={() => setSelected(null)}
                onDeleted={(note) => {
                  setSelected(null);
                  setDeletedNote(note);
                  void load();
                }}
              />
            )}
          </>
        )}

        {tab === 'plans' && (
          <>
            <PlatformPlans onChanged={() => void load()} />

            {settings && (
              <PlatformDiscounts
                currency={settings.currency}
                timeZone={TIMEZONE}
                referralPercent={settings.referralPercent}
                referralMonths={settings.referralMonths}
              />
            )}
          </>
        )}

        {tab === 'messages' && (
          <>
            <PlatformEmail />

            {settings && <PlatformBroadcast plans={settings.plans} timeZone={TIMEZONE} />}

            <PlatformWhatsApp />
          </>
        )}

        {tab === 'settings' && (
          <>
            {settings && (
              <SettingsForm
                settings={settings}
                onSaved={(next) => {
                  setSettings(next);
                  void load();
                }}
              />
            )}

            <ApplySecurity onDone={() => void load()} />

            <SignInProtection load={loadSecurity} forPlatform />

            <section className="admin-panel">
              <div className="panel-title">
                <h2>Errors</h2>
              </div>
              <AdminErrors platform />
            </section>

            <section className="admin-panel">
              <div className="panel-title">
                <h2>Recent changes</h2>
              </div>
              {changes.length === 0 ? (
                <p className="muted">Nothing changed yet.</p>
              ) : (
                <ul className="platform-changes">
                  {changes.slice(0, 30).map((c) => (
                    <li key={`${c.at}-${c.entityId}`}>
                      <span>{formatDate(c.at, TIMEZONE)}</span>
                      <span>
                        <b>{c.by}</b>{' '}
                        {c.action === 'platform.errors_resolved'
                          ? `marked ${String(c.after.count ?? '')} error(s) fixed in ${String(c.after.restaurants ?? '')} place(s)`
                          : c.action === 'platform.settings_saved'
                            ? 'changed the platform settings'
                            : c.action === 'platform.security_applied'
                              ? `applied the security rules for all restaurants (${String(c.after.restaurants ?? '')})`
                              : c.action === 'platform.payment_recorded'
                                ? `recorded a payment from ${names.get(c.entityId) || 'a restaurant'}: ${formatMoney(
                                    Number(c.after.amount) || 0,
                                    currency,
                                  )} for ${String(c.after.months)} month(s)${
                                    c.after.reference ? ` (${String(c.after.reference)})` : ''
                                  }`
                                : c.action === 'platform.broadcast_sent'
                                  ? `emailed ${String(c.after.total ?? '')} owners: “${String(c.after.subject ?? '')}”`
                                  : `changed ${names.get(c.entityId) || 'a restaurant'}`}
                        {c.action === 'platform.restaurant_updated' ||
                        c.action === 'platform.settings_saved'
                          ? describe(c)
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// "price 35000 → 60000" for what changed.
function describe(c: Change) {
  const parts = Object.keys(c.after)
    .filter((key) => show(c.after[key]) !== show(c.before[key]))
    .map((key) => `${key} ${show(c.before[key])} → ${show(c.after[key])}`);
  return parts.length ? `: ${parts.join(', ')}` : '';
}
function show(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object' && value && 'iso' in value)
    return day(String((value as { iso: string }).iso));
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return day(value);
  return String(value);
}

function RestaurantEditor({
  row,
  settings,
  onSaved,
  onClose,
  onDeleted,
}: {
  row: Row;
  settings: Settings;
  onSaved: (row: Row) => void;
  onClose: () => void;
  onDeleted: (note: string) => void;
}) {
  const [price, setPrice] = useState(row.priceOverride === null ? '' : String(row.priceOverride));
  const [plan, setPlan] = useState(row.plan || '');
  const [trialEndsAt, setTrialEndsAt] = useState(toInput(row.trialEndsAt));
  const [paidUntil, setPaidUntil] = useState(toInput(row.paidUntil));
  const [note, setNote] = useState(row.note);
  const [ownerEmail, setOwnerEmail] = useState(row.ownerEmail || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [reset, setReset] = useState<{ username: string; password: string } | null>(null);
  const resetOwner = async () => {
    if (
      !window.confirm(
        `Give ${row.name}'s owner a new password? They are signed out everywhere and must use the new one.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setReset(null);
    try {
      setReset(await Parse.Cloud.run('platformResetOwner', { id: row.id }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  // On phones the editor opens below the list: bring it into view.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const next: Row = await Parse.Cloud.run('platformUpdateRestaurant', {
        id: row.id,
        plan,
        priceOverride: price.trim() === '' ? null : Number(price),
        trialEndsAt: endOfDay(trialEndsAt),
        paidUntil: endOfDay(paidUntil),
        note,
        ownerEmail,
        ...extra,
      });
      setDone('Saved.');
      onSaved(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <section className="admin-panel platform-editor" ref={panel}>
      <div className="panel-title">
        <div>
          <h2>{row.name}</h2>
          <p className="muted">
            {row.code} · {row.ownerName} · {row.billingPhone} · since {day(row.createdAt)}
          </p>
        </div>
        <button className="secondary-button" onClick={onClose}>
          Close
        </button>
      </div>
      {row.deleted ? (
        <p className="muted">
          Its data was deleted on {day(row.deletedAt)} (code {row.deletedCode}). Only its
          subscription payments are kept, for the accounts.
        </p>
      ) : (
        <form className="platform-form" onSubmit={submit}>
          <label className="setup-field">
            Plan
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {settings.plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({formatMoney(p.price, settings.currency)})
                  {p.active ? '' : ' · not offered'}
                </option>
              ))}
            </select>
            <small>Limits and parts of the app come with the plan (Plans below).</small>
          </label>
          <label className="setup-field">
            Monthly price ({row.currency})
            <input
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
              placeholder={`Plan price: ${formatMoney(
                settings.plans.find((p) => p.key === plan)?.price ?? 0,
                settings.currency,
              )}`}
            />
            <small>Leave empty for the plan's price. A negotiated price, higher or lower.</small>
          </label>
          <label className="setup-field">
            Trial ends
            <input
              type="date"
              value={trialEndsAt}
              onChange={(e) => setTrialEndsAt(e.target.value)}
            />
          </label>
          <label className="setup-field">
            Paid until
            <input type="date" value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} />
            <small>To correct it. Payments below move it on by themselves.</small>
          </label>
          <label className="setup-field">
            Owner email
            <input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@example.com"
            />
            <small>
              Password reset links and Relay&apos;s emails go here.
              {row.ownerEmail && (
                <>
                  {' '}
                  <a href={`mailto:${row.ownerEmail}`}>Write to them</a>
                </>
              )}
            </small>
          </label>
          <label className="setup-field platform-note">
            Note (only you see it)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
          {error && <p className="form-error">{error}</p>}
          {done && <p className="form-success">{done}</p>}
          <div className="platform-actions">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className={row.suspended ? 'secondary-button' : 'danger-button'}
              disabled={busy}
              onClick={() => {
                if (
                  row.suspended ||
                  window.confirm(
                    `Suspend ${row.name}? Nobody there can sign in until you lift it. Nothing is deleted.`,
                  )
                )
                  void save({ suspended: !row.suspended });
              }}
            >
              {row.suspended ? 'Lift the suspension' : 'Suspend'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void resetOwner()}
            >
              Reset owner password
            </button>
          </div>
          {reset && (
            <p className="platform-reset" role="status">
              New password for <b>{reset.username}</b>: <code>{reset.password}</code>. Tell the
              owner; it is shown only now. They can change it under their profile after signing in.
            </p>
          )}
          <label className="setup-checkbox platform-note">
            <input
              type="checkbox"
              checked={row.neverDelete}
              disabled={busy}
              onChange={(e) => void save({ neverDelete: e.target.checked })}
            />{' '}
            Never delete automatically
            <small className="muted">
              {row.neverDelete
                ? ' Kept however long it goes unpaid.'
                : row.deletion
                  ? ` Unpaid since ${day(row.deletion.closedAt)}: its data is deleted on ${day(
                      row.deletion.deleteAt,
                    )} unless it pays${row.deletion.warnedAt ? ` (owner warned ${day(row.deletion.warnedAt)})` : ''}.`
                  : settings.deleteAfterDays > 0
                    ? ` Otherwise deleted ${settings.deleteAfterDays} days after the app closes for lack of payment.`
                    : ' Automatic deletion is off (Settings).'}
            </small>
          </label>
        </form>
      )}
      <Payments row={row} onRecorded={onSaved} />
      <DeleteRestaurant row={row} onDeleted={onDeleted} />
    </section>
  );
}

// Deleting a restaurant: a test one completely, a real one keeping its
// subscription payments. The code must be typed to confirm.
type Deleted = {
  counts: {
    zoho?: {
      payments: number;
      invoices: number;
      contact: boolean;
      reposted: string[];
      errors: string[];
    };
  };
};
// One line on what a deletion did, Zoho Books included.
function deletedNote(name: string, everything: boolean, result: Deleted) {
  const z = result.counts.zoho;
  const parts = [
    everything
      ? `${name} is deleted completely.`
      : `${name}'s data is deleted; its payments are kept.`,
  ];
  if (z) {
    const removed = [
      z.invoices && `${z.invoices} invoice${z.invoices === 1 ? '' : 's'}`,
      z.payments && `${z.payments} payment${z.payments === 1 ? '' : 's'}`,
      z.contact && 'the customer',
    ].filter(Boolean);
    if (removed.length) parts.push(`Removed from Zoho Books: ${removed.join(', ')}.`);
    if (z.reposted.length) parts.push(`Earnings journals posted again: ${z.reposted.join(', ')}.`);
    if (z.errors.length)
      parts.push(`Re-post these months by hand in Accounting: ${z.errors.join('; ')}.`);
  }
  return parts.join(' ');
}

function DeleteRestaurant({ row, onDeleted }: { row: Row; onDeleted: (note: string) => void }) {
  const code = row.deleted ? row.deletedCode : row.code;
  const [everything, setEverything] = useState(row.deleted);
  const [zoho, setZoho] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const result: Deleted = await Parse.Cloud.run('platformDeleteRestaurant', {
        id: row.id,
        confirm,
        everything: everything || row.deleted,
        zoho,
      });
      onDeleted(deletedNote(row.name, everything || row.deleted, result));
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <div className="platform-delete">
      <h3>{row.deleted ? 'Remove completely' : 'Delete this restaurant'}</h3>
      {!row.deleted && (
        <div className="platform-delete-choice" role="radiogroup" aria-label="What to delete">
          <label className={`drawer-mode${everything ? ' chosen' : ''}`}>
            <input type="radio" checked={everything} onChange={() => setEverything(true)} />
            <span>
              <b>Everything (a test restaurant)</b>
              <small>
                Every record, staff account, image, order and transaction, its subscription payments
                and the restaurant itself. Nothing is left.
              </small>
            </span>
          </label>
          <label className={`drawer-mode${!everything ? ' chosen' : ''}`}>
            <input type="radio" checked={!everything} onChange={() => setEverything(false)} />
            <span>
              <b>Its data, keeping its subscription payments</b>
              <small>
                For a real restaurant that left: everything goes except the payments it made to
                Relay (and the invoices from them), which stay in Accounting under its name.
              </small>
            </span>
          </label>
        </div>
      )}
      {row.deleted && (
        <p className="muted">
          Also deletes its subscription payments and the restaurant itself: they leave Accounting
          and the revenue figures.
        </p>
      )}
      {(everything || row.deleted) && (
        <label className="setup-checkbox">
          <input type="checkbox" checked={zoho} onChange={(e) => setZoho(e.target.checked)} /> Also
          delete it in Zoho Books
          <small className="muted">
            {' '}
            Its invoices, payments and customer there, if it was sent; months whose earnings journal
            counted it are posted again without it.
          </small>
        </label>
      )}
      <label className="setup-field">
        <span>
          Type <b>{code}</b> to confirm
        </span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="platform-actions">
        <button
          type="button"
          className="danger-button"
          disabled={busy || confirm.trim().toLowerCase() !== code.toLowerCase()}
          onClick={() => void run()}
        >
          {busy ? 'Deleting…' : 'Delete for good'}
        </button>
        <small className="muted">This cannot be undone.</small>
      </div>
    </div>
  );
}

type Payment = {
  id: string;
  createdAt: string | null;
  amount: number;
  currency: string;
  months: number;
  method: 'iotec' | 'manual';
  status: 'pending' | 'paid' | 'failed';
  payer: string;
  message: string;
  reference: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
};

// One restaurant's payments, and recording one received by hand.
function Payments({ row, onRecorded }: { row: Row; onRecorded: (row: Row) => void }) {
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [months, setMonths] = useState('1');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await Parse.Cloud.run('platformListPayments', { id: row.id });
      setRows(result.rows);
    } catch (e) {
      setError(message(e));
    }
  }, [row.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const expected = row.monthlyPrice * (Number(months) || 0);
  const record = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDone('');
    try {
      const payment: Payment = await Parse.Cloud.run('platformRecordPayment', {
        id: row.id,
        months: Number(months),
        amount: amount.trim() === '' ? undefined : Number(amount),
        reference,
      });
      setDone(`Recorded. Paid until ${day(payment.periodEnd)}.`);
      setAmount('');
      setReference('');
      await load();
      const list = await Parse.Cloud.run('platformListRestaurants');
      const next = (list.rows as Row[]).find((r) => r.id === row.id);
      if (next) onRecorded(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="platform-payments">
      <h3>Payments</h3>
      <form className="platform-form" onSubmit={(e) => void record(e)}>
        <label className="setup-field">
          Months paid
          <input
            inputMode="numeric"
            value={months}
            onChange={(e) => setMonths(e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
        <label className="setup-field">
          Amount received ({row.currency})
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            placeholder={formatMoney(expected, row.currency)}
          />
        </label>
        <label className="setup-field">
          Reference (receipt, bank slip)
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        {error && <p className="form-error">{error}</p>}
        {done && <p className="form-success">{done}</p>}
        <div className="platform-actions">
          <button className="secondary-button" disabled={busy || !Number(months)}>
            {busy ? 'Recording…' : 'Record a payment received by hand'}
          </button>
        </div>
      </form>
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>How</th>
                <th>Status</th>
                <th>Reference</th>
                <th className="num">Months</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{day(p.createdAt)}</td>
                  <td>{p.method === 'manual' ? 'By hand' : `Mobile money ${p.payer}`}</td>
                  <td>
                    {p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Not paid' : 'Waiting'}
                    {p.status === 'failed' && p.message && (
                      <small className="cell-sub">{p.message}</small>
                    )}
                  </td>
                  <td>
                    {p.reference || '—'}
                    {p.status === 'paid' && (
                      <button
                        type="button"
                        className="link-button cell-sub"
                        onClick={() => printSubscriptionReceipt(p, row, TIMEZONE)}
                      >
                        Receipt
                      </button>
                    )}
                  </td>
                  <td className="num">{p.months}</td>
                  <td className="num">{formatMoney(p.amount, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// After each Cloud Code upload: the database rules and new fields for the
// whole app, then each restaurant's records, one restaurant per call.
type SecurityStep = {
  total: number | null;
  restaurant: { id: string; name: string; code: string } | null;
  failed: string;
  next: string | null;
};

function ApplySecurity({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<string[]>([]);
  const run = async () => {
    setBusy(true);
    setError('');
    setFailed([]);
    setProgress('Updating the database rules…');
    let after: string | null = null;
    let total = 0;
    let done = 0;
    const missed: string[] = [];
    try {
      for (;;) {
        const step: SecurityStep = await Parse.Cloud.run(
          'platformApplySecurity',
          after ? { after } : {},
        );
        if (step.total !== null) total = step.total;
        if (step.restaurant) {
          done += 1;
          if (step.failed) missed.push(`${step.restaurant.name}: ${step.failed}`);
          setProgress(`Applied for ${done} of ${total}: ${step.restaurant.name}`);
        }
        if (!step.next) break;
        after = step.next;
      }
      setFailed(missed);
      setProgress(
        total === 0
          ? 'Database rules updated. There are no restaurants yet.'
          : `Done: security rules applied for ${done - missed.length} of ${total} restaurant(s).`,
      );
      onDone();
    } catch (e) {
      setProgress('');
      setError(`${message(e)}. Run it again to finish.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>Security rules</h2>
      </div>
      <p className="muted small">
        After uploading a new <code>main.js</code>, apply the security rules once here: it adds new
        database fields and re-applies permissions for every restaurant, including suspended ones.
        Restaurants do not need to do anything. It is safe to run again.
      </p>
      <button className="primary-button" disabled={busy} onClick={() => void run()}>
        {busy ? 'Applying…' : 'Apply security rules to all restaurants'}
      </button>
      {progress && <p className="form-success">{progress}</p>}
      {failed.length > 0 && (
        <div className="form-error">
          Not applied for:
          <ul>
            {failed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function SettingsForm({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}) {
  const [form, setForm] = useState({
    currency: settings.currency,
    trialDays: String(settings.trialDays),
    graceDays: String(settings.graceDays),
    supportContact: settings.supportContact || '',
    billingFrom: settings.billingFrom || '',
    referralPercent: String(settings.referralPercent ?? 10),
    referralMonths: String(settings.referralMonths ?? 1),
    deleteAfterDays: String(settings.deleteAfterDays ?? 30),
    deleteWarnDays: String(settings.deleteWarnDays ?? 3),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDone('');
    try {
      const saved: Settings = await Parse.Cloud.run('platformSaveSettings', {
        currency: form.currency,
        trialDays: Number(form.trialDays),
        graceDays: Number(form.graceDays),
        supportContact: form.supportContact,
        billingFrom: form.billingFrom,
        referralPercent: Number(form.referralPercent),
        referralMonths: Number(form.referralMonths),
        deleteAfterDays: Number(form.deleteAfterDays),
        deleteWarnDays: Number(form.deleteWarnDays),
      });
      setDone('Saved.');
      onSaved(saved);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <h2>Platform settings</h2>
      </div>
      <form className="platform-form" onSubmit={(e) => void submit(e)}>
        <label className="setup-field">
          Currency
          <input value={form.currency} onChange={set('currency')} maxLength={3} />
        </label>
        <label className="setup-field">
          Free trial (days)
          <input inputMode="numeric" value={form.trialDays} onChange={set('trialDays')} />
        </label>
        <label className="setup-field">
          Grace days after a month ends
          <input inputMode="numeric" value={form.graceDays} onChange={set('graceDays')} />
        </label>
        <label className="setup-field platform-note">
          Support contact shown to restaurants
          <input
            value={form.supportContact}
            onChange={set('supportContact')}
            placeholder="e.g. Relay support 0700 000000"
          />
        </label>
        <label className="setup-field">
          Referral discount (% off the first payment)
          <input
            inputMode="numeric"
            value={form.referralPercent}
            onChange={set('referralPercent')}
          />
          <small>0 turns referrals off.</small>
        </label>
        <label className="setup-field">
          Referral reward (free months)
          <input inputMode="numeric" value={form.referralMonths} onChange={set('referralMonths')} />
          <small>For the restaurant whose code was used, once the new one has paid.</small>
        </label>
        <label className="setup-field">
          Delete unpaid restaurants after (days)
          <input
            inputMode="numeric"
            value={form.deleteAfterDays}
            onChange={set('deleteAfterDays')}
          />
          <small>
            Counted from when the app closes for lack of payment. Their data is deleted; their
            subscription payments are kept. 0: never.
          </small>
        </label>
        <label className="setup-field">
          Warn the owner (days before)
          <input inputMode="numeric" value={form.deleteWarnDays} onChange={set('deleteWarnDays')} />
          <small>By email (Account to be deleted). Never deleted sooner after the warning.</small>
        </label>
        <label className="setup-field platform-note">
          Invoices and receipts are from
          <textarea
            rows={5}
            value={form.billingFrom}
            onChange={set('billingFrom')}
            placeholder={
              'Your business name\nStreet, building\nKampala, Uganda\nbilling@yourdomain.com\nTIN 1000000000'
            }
          />
          <small>One per line; the first line is the name.</small>
        </label>
        {error && <p className="form-error">{error}</p>}
        {done && <p className="form-success">{done}</p>}
        <div className="platform-actions">
          <button className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  );
}
