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

type Transaction = {
  id: string;
  kind: 'cash' | 'mobile_money';
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
};

type TillShift = {
  id: string;
  cashier: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  openingFloat: number;
  expectedTill: number | null;
  physicalCount: number | null;
  variance: number | null;
  varianceNote: string;
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
  PENDING_VERIFICATION: 'Waiting for check',
  VERIFIED: 'Verified',
  REJECTED: 'Not received',
  pending: 'Pending',
  confirmed: 'Confirmed',
  disputed: 'Disputed',
};

const STATUS_TONE: Record<string, string> = {
  RECONCILED: 'good',
  VERIFIED: 'good',
  confirmed: 'good',
  REJECTED: 'bad',
  disputed: 'bad',
};

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
  const s = data?.summary;
  const rows = data?.transactions ?? [];
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
        t.kind === 'cash' ? 'Cash' : 'Mobile money',
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
            note="Cash collected plus verified mobile money"
          />
          {filters.method !== 'mobile_money' && (
            <Stat
              label="Cash collected"
              value={money(s.cash.collected)}
              note={`${money(s.cash.reconciled)} reconciled · ${money(
                s.cash.withRiders + s.cash.handoverPending,
              )} not yet`}
            />
          )}
          {filters.method !== 'cash' && (
            <Stat
              label="Mobile money verified"
              value={money(s.mobileMoney.verified)}
              note={
                s.mobileMoney.byProvider.map((p) => `${p.label} ${money(p.amount)}`).join(' · ') ||
                `${s.mobileMoney.verifiedCount} payments`
              }
            />
          )}
          {filters.method !== 'cash' && (
            <Stat
              label="Waiting for a check"
              value={money(s.mobileMoney.pending)}
              note={`${s.mobileMoney.pendingCount} pending · ${s.mobileMoney.rejectedCount} not received`}
            />
          )}
          {filters.method !== 'mobile_money' && (
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
                  <tr key={`${t.kind}-${t.id}`}>
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
                      {t.note && t.kind === 'mobile_money' && <small>{t.note}</small>}
                      {t.kind === 'cash' && t.note && <small>Short: {t.note}</small>}
                    </td>
                    <td>
                      <span className={`status-pill ${STATUS_TONE[t.status] || ''}`}>
                        {STATUS_LABEL[t.status] || t.status}
                      </span>
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
      {filters.method !== 'mobile_money' && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <div>
              <h2>
                Handovers <small>({data?.handovers.length ?? 0})</small>
              </h2>
            </div>
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
                      <tr>
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
      {filters.method !== 'mobile_money' && (
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
            Each shift starts with a counted till. Expected = opening count + cash handovers the
            cashier confirmed during the shift. Any difference must be explained to close.
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
                    <th className="num">Expected</th>
                    <th className="num">Counted</th>
                    <th className="num">Difference</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {tills.data!.shifts.map((t) => (
                    <tr key={t.id}>
                      <td>{t.cashier}</td>
                      <td className="nowrap">
                        {when(t.startedAt)}
                        <small>{t.endedAt ? `to ${when(t.endedAt)}` : 'On shift now'}</small>
                      </td>
                      <td className="num">{money(t.openingFloat)}</td>
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
                      </td>
                      <td>{t.varianceNote || (t.status === 'open' ? '' : '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            tills.data && <p className="empty-orders">No cashier shifts in these dates.</p>
          )}
        </section>
      )}
    </div>
  );
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
  const reopen = async () => {
    if (note.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('reopenHandover', { handoverId: handover.id, note });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reopen dispute');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dispute-panel">
      <strong>
        Disputed cash count: {money(handover.countedAmount || 0)} / claimed {money(handover.amount)}
      </strong>
      <p>{handover.reason}</p>
      <label>
        Resolution note
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Record how this was resolved"
        />
      </label>
      <button disabled={busy || note.trim().length < 5} onClick={() => void reopen()}>
        Return to cashier for recount
      </button>
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}
