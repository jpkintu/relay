import { useState } from 'react';
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
            <p className="eyebrow">Reconciliation</p>
            <h2>
              Transactions <small>({rows.length})</small>
            </h2>
          </div>
        </div>
        <p className="muted small">
          Cash is listed by delivery time, mobile money by order time. Compare mobile money with the
          Airtel / MTN merchant statements by reference.
        </p>
        <div className="admin-table-scroll">
          <div className="table-row table-heading ledger-row">
            <span>Order</span>
            <span>When</span>
            <span>Rider</span>
            <span>Payment</span>
            <span>Status</span>
            <span>Amount</span>
          </div>
          {rows.map((t) => (
            <div className="table-row ledger-row" key={`${t.kind}-${t.id}`}>
              <span>
                {t.code}
                <small>{t.customer}</small>
              </span>
              <span>{when(t.at)}</span>
              <span>{t.rider}</span>
              <span>
                <span className={`pay-kind ${t.kind}`}>{how(t)}</span>
                {t.kind === 'cash' && t.reference && <small>{t.reference}</small>}
                {t.note && t.kind === 'mobile_money' && <small>{t.note}</small>}
                {t.kind === 'cash' && t.note && <small>Short: {t.note}</small>}
              </span>
              <span className={`status-pill ${STATUS_TONE[t.status] || ''}`}>
                {STATUS_LABEL[t.status] || t.status}
              </span>
              <strong>{money(t.amount)}</strong>
            </div>
          ))}
        </div>
        {data && !rows.length && <p className="empty-orders">No payments match these filters.</p>}
        {data?.truncated && (
          <p className="muted small">Showing the latest 2,000. Narrow the dates to see more.</p>
        )}
      </section>
      {filters.method !== 'mobile_money' && (
        <section className="admin-panel admin-section-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Cash</p>
              <h2>
                Handovers <small>({data?.handovers.length ?? 0})</small>
              </h2>
            </div>
          </div>
          <div className="admin-table-scroll">
            {(data?.handovers ?? []).map((h) => (
              <div key={h.id}>
                <div className="table-row">
                  <span>
                    {h.code}
                    <small>{h.orderCount} orders</small>
                  </span>
                  <span>{h.rider}</span>
                  <span className={`status-pill ${STATUS_TONE[h.status] || ''}`}>
                    {STATUS_LABEL[h.status] || h.status}
                  </span>
                  <span>{money(h.amount)}</span>
                  <span>{when(h.createdAt)}</span>
                </div>
                {h.status === 'disputed' && <DisputeResolution handover={h} onResolved={reload} />}
              </div>
            ))}
          </div>
          {data && !data.handovers.length && (
            <p className="empty-orders">No handovers in these dates.</p>
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
