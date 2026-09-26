import { useState } from 'react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { statusLabel } from '../lib/labels';
import { useCloud } from './reports/common';

type Issue = {
  id: string;
  code: string;
  customer: string;
  customerPhone: string;
  rider: string;
  status: string;
  total: number;
  note: string;
  reportedBy: string;
  reportedAt: string | null;
  open: boolean;
  resolution: string;
  resolvedBy: string;
  resolvedAt: string | null;
};

const FILTERS = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
] as const;

// Problems riders and cashiers reported on orders; the owner resolves them.
export function AdminProblems({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<'open' | 'resolved' | 'all'>('open');
  const { data, error, loading, reload } = useCloud<{ open: number; issues: Issue[] }>(
    'adminListIssues',
    { state },
  );
  const issues = data?.issues ?? [];
  return (
    <div className={loading ? 'report busy' : 'report'}>
      <div className="filter-bar">
        <div className="filter-toggle" role="group" aria-label="Show problems">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              className={state === value ? 'active' : ''}
              aria-pressed={state === value}
              onClick={() => setState(value)}
            >
              {label}
              {value === 'open' && data ? ` (${data.open})` : ''}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="ops-error">{error}</p>}
      <div className="issue-list">
        {issues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            onResolved={() => {
              reload();
              onChanged?.();
            }}
          />
        ))}
      </div>
      {data && !issues.length && (
        <p className="empty-orders">
          {state === 'open' ? 'No open problems.' : 'No problems in this list.'}
        </p>
      )}
    </div>
  );
}

function IssueCard({ issue, onResolved }: { issue: Issue; onResolved: () => void }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const when = (at: string | null) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const resolve = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('resolveOrderIssue', { orderId: issue.id, resolution });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resolve');
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={issue.open ? 'issue-card open' : 'issue-card'}>
      <header>
        <span className="code">{issue.code}</span>
        <span className={`status-pill ${issue.open ? 'bad' : 'good'}`}>
          {issue.open ? 'Open' : 'Resolved'}
        </span>
      </header>
      <p className="issue-note">{issue.note}</p>
      <dl>
        <div>
          <dt>Reported by</dt>
          <dd>
            {issue.reportedBy || '—'} · {when(issue.reportedAt)}
          </dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd>
            {issue.customer}
            {issue.customerPhone && ` · ${issue.customerPhone}`} · {money(issue.total)} ·{' '}
            {statusLabel(issue.status)}
          </dd>
        </div>
        <div>
          <dt>Rider</dt>
          <dd>{issue.rider || '—'}</dd>
        </div>
        {!issue.open && (
          <div>
            <dt>Resolution</dt>
            <dd>
              {issue.resolution}
              {issue.resolvedBy && ` — ${issue.resolvedBy}, ${when(issue.resolvedAt)}`}
            </dd>
          </div>
        )}
      </dl>
      {issue.open && (
        <div className="issue-resolve">
          <label>
            How was it resolved?
            <input
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="e.g. Refunded the delivery fee"
              maxLength={300}
            />
          </label>
          <button
            className="primary-button"
            disabled={busy || resolution.trim().length < 5}
            onClick={() => void resolve()}
          >
            {busy ? 'Saving…' : 'Mark resolved'}
          </button>
          {error && <p className="ops-error">{error}</p>}
        </div>
      )}
    </article>
  );
}
