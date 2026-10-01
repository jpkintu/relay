import { useState } from 'react';
import Parse from '../parse';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';
import { useCloud } from './reports/common';

type ErrorRow = {
  id: string;
  source: 'app' | 'server' | 'job';
  where: string;
  message: string;
  stack: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  role: string;
  userName: string;
  userAgent: string;
  url: string;
  appVersion: string;
  resolved: boolean;
  resolvedAt: string | null;
};

const SOURCE_LABEL = { app: 'In the app', server: 'On the server', job: 'Scheduled job' };

// "Android · Chrome" from a user agent, like the notification devices.
function deviceName(userAgent: string) {
  if (!userAgent) return '';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iPhone / iPad'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS/.test(userAgent)
          ? 'Mac'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '';
  return [os, browser].filter(Boolean).join(' · ');
}

// Crashes in the app and failures on the server, grouped: the same problem
// is one entry with a count. Marking one fixed moves it to Fixed; if it
// happens again it comes back.
export function AdminErrors({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<'open' | 'fixed'>('open');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const { data, error, loading, reload } = useCloud<{ open: number; rows: ErrorRow[] }>(
    'adminListErrors',
    { state },
  );
  const rows = data?.rows ?? [];
  const resolve = async (params: { ids?: string[]; all?: boolean }) => {
    setBusy(true);
    setActionError('');
    try {
      await Parse.Cloud.run('adminResolveErrors', params);
      reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={loading ? 'report busy' : 'report'}>
      <p className="section-intro">
        Problems RelayEats ran into on anyone&apos;s phone or computer, and on the server. Mistakes
        people are told about on screen (a wrong PIN, a missing field) are not listed. Send this
        list to whoever maintains RelayEats; mark an entry fixed once the fix is deployed.
      </p>
      <div className="filter-bar">
        <div className="filter-toggle" role="group" aria-label="Show errors">
          {(
            [
              ['open', 'Open'],
              ['fixed', 'Fixed'],
            ] as const
          ).map(([value, label]) => (
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
        {state === 'open' && rows.length > 1 && (
          <button
            className="link-button"
            disabled={busy}
            onClick={() => void resolve({ all: true })}
          >
            Mark all fixed
          </button>
        )}
      </div>
      {(error || actionError) && <p className="ops-error">{error || actionError}</p>}
      <div className="issue-list">
        {rows.map((row) => (
          <ErrorCard
            key={row.id}
            row={row}
            busy={busy}
            onResolve={() => void resolve({ ids: [row.id] })}
          />
        ))}
      </div>
      {data && !rows.length && (
        <p className="empty-orders">
          {state === 'open'
            ? 'No errors. RelayEats is running cleanly.'
            : 'Nothing marked fixed yet.'}
        </p>
      )}
    </div>
  );
}

function ErrorCard({
  row,
  busy,
  onResolve,
}: {
  row: ErrorRow;
  busy: boolean;
  onResolve: () => void;
}) {
  const { timezone } = useConfig();
  const when = (at: string | null) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const who = [row.userName, row.role].filter(Boolean).join(' · ');
  return (
    <article className={row.resolved ? 'issue-card' : 'issue-card open'}>
      <header>
        <span className="code">{SOURCE_LABEL[row.source] || row.source}</span>
        <span className={`status-pill ${row.resolved ? 'good' : 'bad'}`}>
          {row.resolved ? 'Fixed' : row.count > 1 ? `${row.count} times` : 'Once'}
        </span>
      </header>
      <p className="issue-note">{row.message}</p>
      <dl>
        <div>
          <dt>Where</dt>
          <dd>{row.where || '—'}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>
            {when(row.lastSeenAt)}
            {row.count > 1 && ` (first ${when(row.firstSeenAt)})`}
          </dd>
        </div>
        {row.source !== 'job' && (
          <div>
            <dt>Last person</dt>
            <dd>{who || '—'}</dd>
          </div>
        )}
        {row.userAgent && (
          <div>
            <dt>Device</dt>
            <dd>
              {deviceName(row.userAgent) || row.userAgent}
              {row.appVersion && ` · app built ${row.appVersion}`}
            </dd>
          </div>
        )}
        {row.resolved && (
          <div>
            <dt>Marked fixed</dt>
            <dd>{when(row.resolvedAt)}</dd>
          </div>
        )}
      </dl>
      {row.stack && (
        <details className="error-stack">
          <summary>Technical details</summary>
          <pre>{row.stack}</pre>
        </details>
      )}
      {!row.resolved && (
        <div className="issue-resolve">
          <button className="primary-button" disabled={busy} onClick={onResolve}>
            Mark fixed
          </button>
        </div>
      )}
    </article>
  );
}
