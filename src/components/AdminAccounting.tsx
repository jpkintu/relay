import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { FilterBar, filterParams, Stat, useCloud, useFilters } from './reports/common';
import { AdminVouchers } from './AdminVouchers';
import {
  BalanceSheet,
  CashFlowStatement,
  PerformanceRatios,
  ProfitAndLoss,
} from './AccountingStatements';

// Owner and finance: the standard financial statements (Profit and Loss,
// Balance Sheet, Cash Flow Statement, Business Performance Ratios:
// AccountingStatements.tsx), customers' refunds and vouchers, and the EFRIS
// fiscal receipts to follow up.

const TABS = [
  ['pl', 'Profit and Loss'],
  ['balance', 'Balance Sheet'],
  ['cash', 'Cash Flow Statement'],
  ['ratios', 'Business Performance Ratios'],
  ['vouchers', 'Refunds & vouchers'],
  ['tax', 'Tax receipts'],
] as const;
type Tab = (typeof TABS)[number][0];

export function AdminAccounting() {
  const [tab, setTab] = useState<Tab>('pl');
  return (
    <div className="report accounting">
      <div className="filter-toggle spending-tabs no-print" role="tablist" aria-label="Accounting">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'pl' && <ProfitAndLoss />}
      {tab === 'balance' && <BalanceSheet />}
      {tab === 'cash' && <CashFlowStatement />}
      {tab === 'ratios' && <PerformanceRatios />}
      {tab === 'vouchers' && <AdminVouchers />}
      {tab === 'tax' && <TaxReceipts />}
    </div>
  );
}

type TaxRow = {
  id: string;
  code: string;
  at: string;
  total: number;
  customer: string;
  status: 'issued' | 'failed' | 'pending';
  fdn: string;
  error: string;
  attempts: number;
};
const TAX_STATUS: Record<string, [string, string]> = {
  issued: ['Issued', 'good'],
  failed: ['Refused / not sent', 'bad'],
  pending: ['Waiting', 'warn'],
};

function TaxReceipts() {
  const money = useMoney();
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const [filters, setFilters] = useFilters('last7');
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useCloud<{
    enabled: boolean;
    counts: { issued: number; failed: number; pending: number };
    rows: TaxRow[];
  }>('listEfrisReceipts', filterParams(filters, status ? { status } : {}));
  const [busy, setBusy] = useState('');
  const [sendError, setSendError] = useState('');
  const send = async (id: string) => {
    setBusy(id);
    setSendError('');
    try {
      await Parse.Cloud.run('issueEfrisReceipt', { orderId: id });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy('');
      reload();
    }
  };
  return (
    <div className={loading ? 'busy' : ''}>
      <FilterBar filters={filters} onChange={setFilters}>
        <label>
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="failed">Refused / not sent</option>
            <option value="pending">Waiting</option>
            <option value="issued">Issued</option>
          </select>
        </label>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      {data && !data.enabled && (
        <p className="setup-notice">
          EFRIS receipts are off. The owner connects the EFRIS account in Admin → Tax (EFRIS).
        </p>
      )}
      {sendError && <p className="ops-error">{sendError}</p>}
      {data && (
        <>
          <div className="stat-grid">
            <Stat label="Issued" value={data.counts.issued} />
            <Stat label="Refused or not sent" value={data.counts.failed} />
            <Stat label="Waiting" value={data.counts.pending} />
          </div>
          <section className="admin-panel admin-section-panel">
            <div className="table-scroll">
              <table className="data stack-on-phone">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="num">Total</th>
                    <th>Receipt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Order">
                        <button
                          className="link-button"
                          onClick={() => navigate(`/admin/orders/${row.id}`)}
                        >
                          {row.code}
                        </button>
                        <small>
                          {formatDate(row.at, timezone, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                          {row.customer && ` · ${row.customer}`}
                        </small>
                      </td>
                      <td data-label="Total" className="num">
                        {money(row.total)}
                      </td>
                      <td data-label="Receipt">
                        <span className={`status-pill ${TAX_STATUS[row.status]?.[1] || ''}`}>
                          {TAX_STATUS[row.status]?.[0] || row.status}
                        </span>
                        {row.fdn && <small>FDN {row.fdn}</small>}
                        {row.error && <small className="bad-text">{row.error}</small>}
                      </td>
                      <td className="actions-cell">
                        {row.status !== 'issued' && data.enabled && (
                          <button
                            className="setup-secondary"
                            disabled={busy === row.id}
                            onClick={() => void send(row.id)}
                          >
                            {busy === row.id ? 'Sending…' : 'Send now'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!data.rows.length && (
                    <tr>
                      <td colSpan={4} className="empty-orders">
                        No sales to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
