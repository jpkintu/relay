import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate, initials } from '../lib/format';
import { statusLabel, statusTone } from '../lib/labels';
import { Stat, useCloud } from './reports/common';
import { CommissionEditor } from './AdminSetup';
import type { MyHandover } from './RiderMoney';

type OpenOrder = {
  id: string;
  code: string;
  status: string;
  customer: string;
  total: number;
  paymentMethod: string;
  createdAt: string;
};

type Payout = {
  id: string;
  code: string;
  amount: number;
  earned: number;
  deliveryFees: number;
  feesOnly: boolean;
  deductions: number;
  orderCount: number;
  paidBy: string;
  paidAt: string;
};

type Shift = {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  openingFloat: number;
  cashIn: number | null;
  paidOut: number | null;
  expectedTill: number | null;
  physicalCount: number | null;
  variance: number | null;
  varianceNote: string;
};

type Member = {
  id: string;
  name: string;
  username: string;
  phone: string;
  role: string;
  code: string;
  active: boolean;
  available: boolean | null;
  pinLocked: boolean;
  joinedAt: string;
  onShiftSince: string | null;
  commission: { type: string; perOrder: number; percent: number };
  cashLimit: number | null;
  defaultCashLimit: number;
  rider: {
    cash: { held: number; withRider: number; pending: number; momoPending: number; limit: number };
    openOrders: OpenOrder[];
    lifetime: {
      deliveries: number;
      cancelled: number;
      sales: number;
      riderPay: number;
      cashSales: number;
      firstDelivery: string | null;
      lastDelivery: string | null;
    };
    pay: {
      owed: number;
      earned: number;
      deliveryFees: number;
      deductions: number;
      deliveries: number;
    };
    handovers: MyHandover[];
    payouts: Payout[];
  } | null;
  cashier: { heldOrders: OpenOrder[]; shifts: Shift[] } | null;
};

function handoverStatus(h: MyHandover, money: (n: number) => string) {
  if (h.status === 'pending') return { tone: '', label: 'Waiting for a count' };
  if (h.status === 'disputed')
    return { tone: 'bad', label: `Disputed · counted ${money(h.countedAmount ?? 0)}` };
  if (h.shortage) {
    const how =
      h.shortageStatus === 'written_off'
        ? 'written off'
        : h.shortageStatus === 'owed'
          ? 'to take off pay'
          : 'taken off pay';
    return { tone: 'bad', label: `${money(h.shortage)} short · ${how}` };
  }
  if (h.returnedCount) return { tone: '', label: `${h.returnedCount} returned to the rider` };
  return { tone: 'good', label: h.receivedByOwner ? 'Received by the owner' : 'Received' };
}

// Owner: one rider's or cashier's page, from Team.
export function AdminMember({ id }: { id: string }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const { data: m, error, reload } = useCloud<Member>('adminGetMember', { id });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [resetting, setResetting] = useState(false);

  const act = async (fn: string, payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await Parse.Cloud.run(fn, payload);
      setNotice(done);
      reload();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const date = (value: string | null) =>
    value ? formatDate(value, timezone, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const back = (
    <button className="back-link" onClick={() => navigate('/admin/team')}>
      <ArrowLeft /> Team
    </button>
  );

  if (error)
    return (
      <div className="member-page">
        {back}
        <p className="ops-error">{error}</p>
      </div>
    );
  if (!m)
    return (
      <div className="member-page">
        {back}
        <p className="muted">Loading…</p>
      </div>
    );

  const staff = m.role === 'rider' || m.role === 'cashier';
  const r = m.rider;
  const c = m.cashier;
  const limitValue = limit ?? (m.cashLimit === null ? '' : String(m.cashLimit));

  return (
    <div className="member-page">
      {back}
      <section className="admin-panel member-head">
        <div className="profile-avatar">{initials(m.name)}</div>
        <div>
          <h2>{m.name}</h2>
          <p className="muted">
            {m.code && `${m.code} · `}@{m.username}
            {m.phone && ` · ${m.phone}`} · {m.role === 'admin' ? 'owner' : m.role}
          </p>
          <div className="member-tags">
            <span className={`status-pill ${m.active ? 'good' : 'bad'}`}>
              {m.active ? 'Active' : 'Deactivated'}
            </span>
            {m.available !== null && (
              <span className={`status-pill ${m.available ? 'good' : ''}`}>
                {m.available ? 'Available' : 'On a break'}
              </span>
            )}
            <span className="status-pill">
              {m.onShiftSince ? `On shift since ${date(m.onShiftSince)}` : 'Off shift'}
            </span>
            {m.pinLocked && <span className="status-pill bad">PIN locked</span>}
          </div>
        </div>
      </section>
      {notice && <p className="setup-notice">{notice}</p>}
      {actionError && <p className="ops-error">{actionError}</p>}

      {r && (
        <div className="stat-grid">
          <Stat
            label="Cash held"
            value={money(r.cash.held)}
            note={
              r.cash.limit > 0
                ? `of a ${money(r.cash.limit)} limit${r.cash.pending ? ` · ${money(r.cash.pending)} handed over, not counted` : ''}`
                : 'No cash limit'
            }
          />
          <Stat
            label="Owed to the rider"
            value={money(r.pay.owed)}
            note={`${r.pay.deliveries} unpaid ${r.pay.deliveries === 1 ? 'delivery' : 'deliveries'}${
              r.pay.deductions ? ` · less ${money(r.pay.deductions)} shortage` : ''
            }`}
          />
          <Stat
            label="Deliveries"
            value={r.lifetime.deliveries}
            note={`${r.lifetime.cancelled} cancelled · since ${
              r.lifetime.firstDelivery
                ? formatDate(r.lifetime.firstDelivery, timezone, { dateStyle: 'medium' })
                : 'joining'
            }`}
          />
          <Stat
            label="Sales delivered"
            value={money(r.lifetime.sales)}
            note={`${money(r.lifetime.riderPay)} earned by the rider`}
          />
        </div>
      )}

      {r && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Open orders <small>({r.openOrders.length})</small>
            </h2>
          </div>
          {r.cash.momoPending > 0 && (
            <p className="muted small">
              {r.cash.momoPending} mobile money {r.cash.momoPending === 1 ? 'payment' : 'payments'}{' '}
              taken at the door still waiting for a cashier.
            </p>
          )}
          <OrderTable orders={r.openOrders} empty="No open orders." />
        </section>
      )}

      {c && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Kitchen orders held <small>({c.heldOrders.length})</small>
            </h2>
          </div>
          <OrderTable orders={c.heldOrders} empty="Not holding any kitchen orders." />
        </section>
      )}

      {staff && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Account</h2>
          </div>
          <div className="member-actions">
            {editing ? (
              <form
                className="member-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('adminUpdateMember', { id: m.id, name, phone }, 'Details saved.').then(
                    (ok) => ok && setEditing(false),
                  );
                }}
              >
                <label className="setup-field">
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                </label>
                <label className="setup-field">
                  Phone
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
                </label>
                <div className="payment-actions">
                  <button disabled={busy || !name.trim()}>Save details</button>
                  <button
                    type="button"
                    className="setup-secondary"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="member-action">
                <div>
                  <b>Name and phone</b>
                  <small>
                    {m.name}
                    {m.phone ? ` · ${m.phone}` : ' · no phone'}
                  </small>
                </div>
                <button
                  className="setup-secondary"
                  onClick={() => {
                    setName(m.name);
                    setPhone(m.phone);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
              </div>
            )}
            <div className="member-action">
              <div>
                <b>Role</b>
                <small>Changing the role moves them to the other app.</small>
              </div>
              <select
                aria-label="Role"
                value={m.role}
                disabled={busy}
                onChange={(e) =>
                  void act(
                    'adminChangeRole',
                    { userId: m.id, role: e.target.value },
                    `Now a ${e.target.value}.`,
                  )
                }
              >
                <option value="rider">Rider</option>
                <option value="cashier">Cashier</option>
              </select>
            </div>
            <div className="member-action">
              <div>
                <b>PIN</b>
                <small>
                  {m.pinLocked
                    ? 'Locked after five wrong PINs. A new PIN unlocks it.'
                    : 'Set a new PIN if they forgot theirs. They are signed out everywhere.'}
                </small>
              </div>
              {resetting ? (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      'adminResetPin',
                      { id: m.id, pin: newPin },
                      `New PIN set. Tell ${m.name.split(' ')[0]} their new PIN.`,
                    ).then((ok) => {
                      if (ok) {
                        setNewPin('');
                        setResetting(false);
                      }
                    });
                  }}
                >
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    placeholder="New PIN (4+ digits)"
                    aria-label="New PIN"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                  />
                  <button disabled={busy || newPin.length < 4}>Set PIN</button>
                  <button
                    type="button"
                    className="setup-secondary"
                    onClick={() => {
                      setNewPin('');
                      setResetting(false);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button className="setup-secondary" onClick={() => setResetting(true)}>
                  <KeyRound /> Reset PIN
                </button>
              )}
            </div>
            <div className="member-action">
              <div>
                <b>{m.active ? 'Deactivate' : 'Activate'}</b>
                <small>
                  {m.active
                    ? 'Signs them out and stops them signing in. Their history stays.'
                    : 'Lets them sign in again with their PIN.'}
                </small>
              </div>
              <button
                className={m.active ? 'setup-secondary danger' : 'setup-secondary'}
                disabled={busy}
                onClick={() => {
                  if (
                    m.active &&
                    r &&
                    (r.cash.held > 0 || r.openOrders.length) &&
                    !window.confirm(
                      `${m.name} still has ${
                        r.cash.held > 0 ? `${money(r.cash.held)} in cash` : 'open orders'
                      }. Deactivate anyway?`,
                    )
                  )
                    return;
                  void act(
                    'adminUpdateMember',
                    { id: m.id, active: !m.active },
                    m.active ? 'Deactivated and signed out.' : 'Activated.',
                  );
                }}
              >
                {m.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        </section>
      )}

      {r && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>Pay and cash limit</h2>
          </div>
          <CommissionEditor
            key={`${m.commission.type}-${m.commission.perOrder}-${m.commission.percent}`}
            member={{
              commissionType: m.commission.type,
              commissionPerOrder: m.commission.perOrder,
              commissionPercent: m.commission.percent,
            }}
            disabled={busy}
            save={async (payload) => {
              await act('adminUpdateMember', { id: m.id, ...payload }, 'Commission rule saved.');
            }}
          />
          <form
            className="commission-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'adminUpdateMember',
                { id: m.id, maxFloat: limitValue === '' ? null : Number(limitValue) },
                limitValue === ''
                  ? 'Uses the restaurant cash limit.'
                  : `Cash limit set to ${money(Number(limitValue))}.`,
              ).then((ok) => ok && setLimit(null));
            }}
          >
            <label>
              Cash limit
              <input
                type="number"
                min="0"
                inputMode="numeric"
                placeholder={money(m.defaultCashLimit)}
                value={limitValue}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <button disabled={busy}>Save limit</button>
            {m.cashLimit !== null && (
              <button
                type="button"
                className="setup-secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    'adminUpdateMember',
                    { id: m.id, maxFloat: null },
                    'Uses the restaurant cash limit.',
                  ).then((ok) => ok && setLimit(null))
                }
              >
                Use restaurant limit
              </button>
            )}
          </form>
          <p className="muted small">
            Leave the cash limit empty to use the restaurant&apos;s {money(m.defaultCashLimit)}. Set
            0 for no limit.
          </p>
        </section>
      )}

      {r && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Cash handovers <small>(latest {r.handovers.length})</small>
            </h2>
          </div>
          {r.handovers.length ? (
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Handover</th>
                    <th>Handed over</th>
                    <th className="num">Orders</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {r.handovers.map((h) => {
                    const state = handoverStatus(h, money);
                    return (
                      <tr key={h.id}>
                        <td data-label="Handover">
                          <span className="code">{h.code}</span>
                        </td>
                        <td data-label="Handed over" className="nowrap">
                          {date(h.handedOverAt)}
                        </td>
                        <td data-label="Orders" className="num">
                          {h.orderCount}
                        </td>
                        <td data-label="Amount" className="num strong">
                          {money(h.amount)}
                        </td>
                        <td data-label="Status">
                          <span className={`status-pill ${state.tone}`}>{state.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-orders">No cash handovers yet.</p>
          )}
        </section>
      )}

      {r && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Pay received <small>(latest {r.payouts.length})</small>
            </h2>
          </div>
          {r.payouts.length ? (
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Payout</th>
                    <th>Paid</th>
                    <th>For</th>
                    <th>Paid by</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {r.payouts.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Payout">
                        <span className="code">{p.code}</span>
                      </td>
                      <td data-label="Paid" className="nowrap">
                        {date(p.paidAt)}
                      </td>
                      <td data-label="For">
                        {p.feesOnly ? 'Delivery fees at the cash handover' : 'Rider pay'}
                        <small>
                          {p.orderCount} {p.orderCount === 1 ? 'delivery' : 'deliveries'}
                          {p.deductions ? ` · − ${money(p.deductions)} shortage` : ''}
                        </small>
                      </td>
                      <td data-label="Paid by">{p.paidBy}</td>
                      <td data-label="Amount" className="num strong">
                        {money(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-orders">Nothing paid yet.</p>
          )}
        </section>
      )}

      {r && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>All time</h2>
          </div>
          <dl className="member-lifetime">
            <div>
              <dt>Joined</dt>
              <dd>{formatDate(m.joinedAt, timezone, { dateStyle: 'medium' })}</dd>
            </div>
            <div>
              <dt>Deliveries</dt>
              <dd>{r.lifetime.deliveries}</dd>
            </div>
            <div>
              <dt>Cancelled orders</dt>
              <dd>{r.lifetime.cancelled}</dd>
            </div>
            <div>
              <dt>Sales delivered</dt>
              <dd>{money(r.lifetime.sales)}</dd>
            </div>
            <div>
              <dt>Of which cash</dt>
              <dd>{money(r.lifetime.cashSales)}</dd>
            </div>
            <div>
              <dt>Earned by the rider</dt>
              <dd>{money(r.lifetime.riderPay)}</dd>
            </div>
            <div>
              <dt>Last delivery</dt>
              <dd>{date(r.lifetime.lastDelivery)}</dd>
            </div>
          </dl>
        </section>
      )}

      {c && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Shifts <small>(latest {c.shifts.length})</small>
            </h2>
          </div>
          {c.shifts.length ? (
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Ended</th>
                    <th className="num">Opening</th>
                    <th className="num">Cash in</th>
                    <th className="num">Paid out</th>
                    <th className="num">Expected</th>
                    <th className="num">Counted</th>
                    <th className="num">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {c.shifts.map((sh) => (
                    <tr key={sh.id}>
                      <td data-label="Started" className="nowrap">
                        {date(sh.startedAt)}
                      </td>
                      <td data-label="Ended" className="nowrap">
                        {sh.status === 'open' ? (
                          <span className="status-pill good">Open</span>
                        ) : (
                          date(sh.endedAt)
                        )}
                      </td>
                      <td data-label="Opening" className="num">
                        {money(sh.openingFloat)}
                      </td>
                      <td data-label="Cash in" className="num">
                        {sh.cashIn === null ? '—' : money(sh.cashIn)}
                      </td>
                      <td data-label="Paid out" className="num">
                        {sh.paidOut === null ? '—' : money(sh.paidOut)}
                      </td>
                      <td data-label="Expected" className="num">
                        {sh.expectedTill === null ? '—' : money(sh.expectedTill)}
                      </td>
                      <td data-label="Counted" className="num">
                        {sh.physicalCount === null ? '—' : money(sh.physicalCount)}
                      </td>
                      <td
                        data-label="Difference"
                        className={`num ${sh.variance ? 'down' : ''}`}
                        title={sh.varianceNote || undefined}
                      >
                        {sh.variance === null
                          ? '—'
                          : sh.variance === 0
                            ? 'Matched'
                            : `${sh.variance > 0 ? '+' : '−'} ${money(Math.abs(sh.variance))}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-orders">No shifts yet.</p>
          )}
        </section>
      )}
    </div>
  );
}

function OrderTable({ orders, empty }: { orders: OpenOrder[]; empty: string }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const date = (value: string) =>
    formatDate(value, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  if (!orders.length) return <p className="empty-orders">{empty}</p>;
  return (
    <div className="table-scroll">
      <table className="data stack-on-phone">
        <thead>
          <tr>
            <th>Order</th>
            <th>Placed</th>
            <th>Customer</th>
            <th>Status</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td data-label="Order">
                <span className="code">{o.code}</span>
              </td>
              <td data-label="Placed" className="nowrap">
                {date(o.createdAt)}
              </td>
              <td data-label="Customer">
                {o.customer}
                <small>{o.paymentMethod === 'cash' ? 'Cash' : 'Mobile money'}</small>
              </td>
              <td data-label="Status">
                <span className={`status-pill ${statusTone(o.status)}`}>
                  {statusLabel(o.status)}
                </span>
              </td>
              <td data-label="Total" className="num strong">
                {money(o.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
