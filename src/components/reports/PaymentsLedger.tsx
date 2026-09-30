import { Fragment, useState } from 'react';
import Parse from '../../parse';
import { useConfig, useMoney } from '../../lib/session';
import { formatDate } from '../../lib/format';
import { providerLabel } from '../MobileMoney';
import {
  FilterBar,
  Stat,
  downloadCsv,
  filterParams,
  useCloud,
  useFilters,
  useRiderOptions,
} from './common';
import { CashCheckPanel, PayoutsPanel, ReceiveCash } from './CashControls';

type Transaction = {
  id: string;
  kind: 'cash' | 'mobile_money' | 'card';
  at: string;
  code: string;
  riderId: string;
  rider: string;
  customer: string;
  amount: number;
  orderTotal: number;
  status: string;
  provider: string;
  reference: string;
  note: string;
};

type Handover = {
  id: string;
  code: string;
  rider: string;
  cashier: string;
  amount: number;
  countedAmount: number | null;
  orderCount: number;
  status: string;
  reason: string;
  createdAt: string;
  returnedAmount: number;
  shortage: number;
  shortageStatus: string;
  resolutionNote: string;
  receivedByOwner: boolean;
};

type TillShift = {
  id: string;
  cashier: string;
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
  // The difference before the owner settled it, and how it was settled.
  originalVariance: number | null;
  settled: boolean;
  settlementNote: string;
};

type Ledger = {
  summary: {
    total: number;
    cash: {
      count: number;
      collected: number;
      withRiders: number;
      handoverPending: number;
      reconciled: number;
      inTill: number;
    };
    mobileMoney: {
      count: number;
      verified: number;
      verifiedCount: number;
      pending: number;
      pendingCount: number;
      rejected: number;
      rejectedCount: number;
      byProvider: {
        provider: string;
        label: string;
        code: string;
        count: number;
        amount: number;
      }[];
    };
    card?: {
      count: number;
      verified: number;
      verifiedCount: number;
      pending: number;
      pendingCount: number;
      rejectedCount: number;
    };
    handovers: { count: number; confirmed: number; pending: number; disputed: number };
  };
  transactions: Transaction[];
  truncated: boolean;
  handovers: Handover[];
};

export const STATUS_LABEL: Record<string, string> = {
  WITH_RIDER: 'With rider',
  HANDOVER_PENDING: 'Handover pending',
  RECONCILED: 'Reconciled',
  IN_TILL: 'In the till (counter)',
  REFUNDED: 'Refunded',
  UNPAID: 'Not paid yet',
  PENDING_VERIFICATION: 'Waiting for check',
  VERIFIED: 'Verified',
  REJECTED: 'Not received',
  pending: 'Pending',
  confirmed: 'Confirmed',
  disputed: 'Disputed',
};

const STATUS_TONE: Record<string, string> = {
  RECONCILED: 'good',
  IN_TILL: 'good',
  VERIFIED: 'good',
  confirmed: 'good',
  REJECTED: 'bad',
  disputed: 'bad',
};

// Money still waiting (with a rider, in a handover, or a payment to check)
// longer than this is highlighted, like the cashier's handover list.
const STALE_HOURS = 4;
const WAITING = ['WITH_RIDER', 'HANDOVER_PENDING', 'PENDING_VERIFICATION', 'pending'];
const hoursSince = (at: string) => Math.floor((Date.now() - new Date(at).getTime()) / 3600000);
const overdue = (status: string, at: string | null | undefined) =>
  !!at && WAITING.includes(status) && hoursSince(at) >= STALE_HOURS;

function WaitingTag({ at }: { at: string }) {
  return <em className="stale-tag">Waiting {hoursSince(at)} h</em>;
}

export function PaymentsLedger() {
  const money = useMoney();
  const { timezone } = useConfig();
  const [filters, setFilters] = useFilters('last7');
  const riders = useRiderOptions();
  const { data, error, loading, reload } = useCloud<Ledger>(
    'getPaymentsLedger',
    filterParams(filters),
  );
  const tills = useCloud<{ shifts: TillShift[]; totalVariance: number }>('getShiftReport', {
    from: filters.from,
    to: filters.to,
  });
  const [settling, setSettling] = useState<string | null>(null);
  const s = data?.summary;
  const rows = data?.transactions ?? [];
  const showCash = !filters.method || filters.method === 'cash';
  const showMomo = !filters.method || filters.method === 'mobile_money';
  const showCard = filters.method === 'card' || (!filters.method && !!s?.card?.count);
  const staleCount = rows.filter((t) => overdue(t.status, t.at)).length;
  const when = (at: string) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const how = (t: Transaction) =>
    t.kind === 'cash' ? 'Cash' : `${providerLabel(t.provider)} · ${t.reference}`;
  const exportCsv = () =>
    downloadCsv(
      `relay-payments-${filters.from}-to-${filters.to}`,
      [
        'Date',
        'Order',
        'Rider',
        'Customer',
        'Type',
        'Provider',
        'Reference / handover',
        'Amount',
        'Order total',
        'Status',
        'Note',
      ],
      rows.map((t) => [
        when(t.at),
        t.code,
        t.rider,
        t.customer,
        t.kind === 'cash' ? 'Cash' : t.kind === 'card' ? 'Card' : 'Mobile money',
        t.provider ? providerLabel(t.provider) : '',
        t.reference,
        t.amount,
        t.orderTotal,
        STATUS_LABEL[t.status] || t.status,
        t.note,
      ]),
    );

  return (
    <div className={loading ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters} riders={riders} showMethod>
        <button className="filter-action" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {s && (
        <div className="stat-grid">
          <Stat
            label="Total received"
            value={money(s.total)}
            note="Cash collected plus verified mobile money and card"
          />
          {showCash && (
            <Stat
              label="Cash collected"
              value={money(s.cash.collected)}
              note={`${money(s.cash.reconciled)} from riders, reconciled${
                s.cash.inTill ? ` · ${money(s.cash.inTill)} taken at the counter` : ''
              } · ${money(s.cash.withRiders + s.cash.handoverPending)} still with riders`}
            />
          )}
          {showMomo && (
            <Stat
              label="Mobile money verified"
              value={money(s.mobileMoney.verified)}
              note={
                s.mobileMoney.byProvider.map((p) => `${p.label} ${money(p.amount)}`).join(' · ') ||
                `${s.mobileMoney.verifiedCount} payments`
              }
            />
          )}
          {showMomo && (
            <Stat
              label="Waiting for a check"
              value={money(s.mobileMoney.pending)}
              note={`${s.mobileMoney.pendingCount} pending · ${s.mobileMoney.rejectedCount} not received`}
            />
          )}
          {showCard && s.card && (
            <Stat
              label="Card verified"
              value={money(s.card.verified)}
              note={`${s.card.verifiedCount} payments · ${money(s.card.pending)} waiting for a check${
                s.card.rejectedCount ? ` · ${s.card.rejectedCount} not received` : ''
              }`}
            />
          )}
          {showCash && (
            <Stat
              label="Handovers confirmed"
              value={money(s.handovers.confirmed)}
              note={`${money(s.handovers.pending)} pending · ${s.handovers.disputed} disputed`}
            />
          )}
        </div>
      )}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <div>
            <h2>
              Transactions <small>({rows.length})</small>
            </h2>
          </div>
        </div>
        <p className="muted small">
          Cash is listed by delivery time, mobile money by order time. Compare mobile money with the
          Airtel / MTN merchant statements by reference.
        </p>
        {staleCount > 0 && (
          <p className="stale-summary" role="status">
            {staleCount} payment{staleCount === 1 ? ' has' : 's have'} been waiting more than{' '}
            {STALE_HOURS} h (cash still with a rider or in a handover, or mobile money not checked):
            highlighted below.
          </p>
        )}
        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>When</th>
                  <th>Rider</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={`${t.kind}-${t.id}`}
                    className={overdue(t.status, t.at) ? 'stale-row' : undefined}
                  >
                    <td>
                      <span className="code">{t.code}</span>
                      <small>{t.customer}</small>
                    </td>
                    <td className="nowrap">{when(t.at)}</td>
                    <td>{t.rider}</td>
                    <td>
                      <span className="pay-kind">{how(t)}</span>
                      {t.kind === 'cash' && t.reference && (
                        <small>
                          Handover <span className="code">{t.reference}</span>
                        </small>
                      )}
                      {t.note && t.kind !== 'cash' && <small>{t.note}</small>}
                      {t.kind === 'cash' && t.note && <small>Short: {t.note}</small>}
                    </td>
                    <td>
                      <span className={`status-pill ${STATUS_TONE[t.status] || ''}`}>
                        {STATUS_LABEL[t.status] || t.status}
                      </span>
                      {overdue(t.status, t.at) && <WaitingTag at={t.at} />}
                    </td>
                    <td className="num">{money(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && !rows.length && <p className="empty-orders">No payments match these filters.</p>}
        {data?.truncated && (
          <p className="muted small">Showing the latest 2,000. Narrow the dates to see more.</p>
        )}
      </section>
      {showCash && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <div>
              <h2>
                Handovers <small>({data?.handovers.length ?? 0})</small>
              </h2>
            </div>
            <ReceiveCash riders={riders} onDone={reload} />
          </div>
          {(data?.handovers.length ?? 0) > 0 && (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Handover</th>
                    <th>Rider</th>
                    <th>Handed over</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.handovers ?? []).map((h) => (
                    <Fragment key={h.id}>
                      <tr className={overdue(h.status, h.createdAt) ? 'stale-row' : undefined}>
                        <td>
                          <span className="code">{h.code}</span>
                          <small>
                            {h.orderCount} order{h.orderCount === 1 ? '' : 's'}
                          </small>
                        </td>
                        <td>{h.rider}</td>
                        <td className="nowrap">{when(h.createdAt)}</td>
                        <td>
                          <span className={`status-pill ${STATUS_TONE[h.status] || ''}`}>
                            {STATUS_LABEL[h.status] || h.status}
                          </span>
                          {overdue(h.status, h.createdAt) && <WaitingTag at={h.createdAt} />}
                          {handoverNote(h, money) && <small>{handoverNote(h, money)}</small>}
                        </td>
                        <td className="num">{money(h.amount)}</td>
                      </tr>
                      {h.status === 'disputed' && (
                        <tr className="detail-row">
                          <td colSpan={5}>
                            <DisputeResolution handover={h} onResolved={reload} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && !data.handovers.length && (
            <p className="empty-orders">No handovers in these dates.</p>
          )}
        </section>
      )}
      {showCash && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <h2>
              Cashier shifts <small>({tills.data?.shifts.length ?? 0})</small>
            </h2>
            {tills.data && tills.data.totalVariance !== 0 && (
              <span className={`status-pill ${tills.data.totalVariance < 0 ? 'bad' : 'good'}`}>
                Till {tills.data.totalVariance < 0 ? 'short' : 'over'}{' '}
                {money(Math.abs(tills.data.totalVariance))} in total
              </span>
            )}
          </div>
          <p className="muted small">
            Each shift starts with a counted till. Expected = opening count + cash the cashier took
            in from riders − payouts. Any difference must be explained to close.
          </p>
          {tills.error && <p className="ops-error">{tills.error}</p>}
          {(tills.data?.shifts.length ?? 0) > 0 ? (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Cashier</th>
                    <th>Shift</th>
                    <th className="num">Opening</th>
                    <th className="num">Cash in</th>
                    <th className="num">Paid out</th>
                    <th className="num">Expected</th>
                    <th className="num">Counted</th>
                    <th className="num">Difference</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {tills.data!.shifts.map((t) => (
                    <Fragment key={t.id}>
                      <tr>
                        <td>{t.cashier}</td>
                        <td className="nowrap">
                          {when(t.startedAt)}
                          <small>{t.endedAt ? `to ${when(t.endedAt)}` : 'On shift now'}</small>
                        </td>
                        <td className="num">{money(t.openingFloat)}</td>
                        <td className="num">{t.cashIn === null ? '—' : money(t.cashIn)}</td>
                        <td className="num">{t.paidOut === null ? '—' : money(t.paidOut)}</td>
                        <td className="num">
                          {t.expectedTill === null ? '—' : money(t.expectedTill)}
                        </td>
                        <td className="num">
                          {t.physicalCount === null ? '—' : money(t.physicalCount)}
                        </td>
                        <td
                          className={`num strong ${
                            !t.variance ? '' : t.variance < 0 ? 'down' : 'up'
                          }`}
                        >
                          {t.variance === null
                            ? '—'
                            : t.variance === 0
                              ? 'Matched'
                              : `${t.variance > 0 ? '+' : '−'}${money(Math.abs(t.variance))}`}
                          {t.originalVariance !== null && t.originalVariance !== t.variance && (
                            <small>
                              was {t.originalVariance > 0 ? '+' : '−'}
                              {money(Math.abs(t.originalVariance))}
                            </small>
                          )}
                        </td>
                        <td>
                          {t.varianceNote || (t.status === 'open' ? '' : '—')}
                          {t.settled && (
                            <small className="settled-note">
                              <span className="status-pill good">Settled</span> {t.settlementNote}
                            </small>
                          )}
                          {!t.settled && !!t.variance && t.status === 'closed' && (
                            <button
                              className="link-button settle-button"
                              onClick={() => setSettling(settling === t.id ? null : t.id)}
                            >
                              {settling === t.id ? 'Close' : 'Settle'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {settling === t.id && (
                        <tr className="detail-row">
                          <td colSpan={9}>
                            <SettleTill
                              till={t}
                              onDone={() => {
                                setSettling(null);
                                tills.reload();
                                reload();
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            tills.data && <p className="empty-orders">No cashier shifts in these dates.</p>
          )}
        </section>
      )}
      {showCash && <PayoutsPanel from={filters.from} to={filters.to} />}
      <CashCheckPanel />
    </div>
  );
}

// Short line under a handover's status: what happened to missing cash.
function handoverNote(h: Handover, money: (n: number) => string) {
  if (h.receivedByOwner) return 'Taken by the owner';
  if (h.shortageStatus === 'owed') return `${money(h.shortage)} short · off rider's next pay`;
  if (h.shortageStatus === 'deducted') return `${money(h.shortage)} short · taken off pay`;
  if (h.shortageStatus === 'written_off') return `${money(h.shortage)} short · written off`;
  if (h.returnedAmount) return `${money(h.returnedAmount)} returned to rider`;
  return '';
}

function DisputeResolution({
  handover,
  onResolved,
}: {
  handover: { id: string; reason: string; amount: number; countedAmount: number | null };
  onResolved: () => void;
}) {
  const money = useMoney();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shortage = handover.amount - (handover.countedAmount || 0);
  const resolve = async (action: 'deduct' | 'write_off' | 'reopen') => {
    if (note.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('adminResolveHandover', {
        handoverId: handover.id,
        action,
        note: note.trim(),
      });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resolve the dispute');
    } finally {
      setBusy(false);
    }
  };
  const ready = !busy && note.trim().length >= 5;
  return (
    <div className="dispute-panel">
      <strong>
        Counted {money(handover.countedAmount || 0)} of {money(handover.amount)} · {money(shortage)}{' '}
        short
      </strong>
      <p>{handover.reason}</p>
      <label>
        Resolution note
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What you agreed with the rider"
        />
      </label>
      <div className="dispute-actions">
        <button disabled={!ready} onClick={() => void resolve('deduct')}>
          Take {money(shortage)} off the rider&apos;s pay
        </button>
        <button disabled={!ready} onClick={() => void resolve('write_off')}>
          Write it off
        </button>
        <button
          className="setup-secondary"
          disabled={!ready}
          onClick={() => void resolve('reopen')}
        >
          Recount at the counter
        </button>
      </div>
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}

// Owner: settle a till difference. A short till is usually cash paid out
// without being recorded (fees, supplies): record that payment and the
// difference shrinks. What is left can be written off with a note.
function SettleTill({ till, onDone }: { till: TillShift; onDone: () => void }) {
  const money = useMoney();
  const short = (till.variance ?? 0) < 0;
  const gap = Math.abs(till.variance ?? 0);
  const [mode, setMode] = useState<'payout' | 'writeoff'>(short ? 'payout' : 'writeoff');
  const [amount, setAmount] = useState(String(gap));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready =
    !busy &&
    note.trim().length >= 5 &&
    (mode === 'writeoff' || (Number(amount) > 0 && Number(amount) <= gap));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('adminSettleTillDifference', {
        shiftId: till.id,
        mode,
        amount: Number(amount),
        note: note.trim(),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not settle the till');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dispute-panel settle-panel">
      <strong>
        {till.cashier}: till {short ? 'short' : 'over'} by {money(gap)}
      </strong>
      {till.varianceNote && <p>Cashier said: {till.varianceNote}</p>}
      <div className="settle-modes" role="radiogroup" aria-label="How to settle">
        {short && (
          <label>
            <input type="radio" checked={mode === 'payout'} onChange={() => setMode('payout')} />
            Match a till payment that was not recorded (lowers the expected till)
          </label>
        )}
        <label>
          <input type="radio" checked={mode === 'writeoff'} onChange={() => setMode('writeoff')} />
          {short ? 'Write it off as a loss' : 'Accept the extra cash'}
        </label>
      </div>
      {mode === 'payout' && (
        <label>
          Amount paid out ({money(gap)} at most)
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max={gap}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      )}
      <label>
        {mode === 'payout' ? 'What was it paid for?' : 'Note'}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder={
            mode === 'payout' ? 'e.g. Delivery fees paid to riders' : 'e.g. Counting error'
          }
        />
      </label>
      {error && <p className="ops-error">{error}</p>}
      <div className="dispute-actions">
        <button disabled={!ready} onClick={() => void submit()}>
          {busy
            ? 'Saving…'
            : mode === 'payout'
              ? `Record ${money(Number(amount) || 0)} payment`
              : short
                ? 'Write off'
                : 'Accept'}
        </button>
      </div>
    </div>
  );
}
