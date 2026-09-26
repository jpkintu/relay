import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Parse from '../parse';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';
import { AUDIT_GROUP_LABEL, actionLabel, changedFields } from '../lib/audit';
import { FilterBar, downloadCsv, useCloud, useFilters } from './reports/common';

type Row = {
  id: string;
  at: string;
  action: string;
  actorId: string;
  actor: string;
  entityType: string;
  entityId: string;
  entity: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};
type Page = { rows: Row[]; next: string | null; groups: string[] };
type Person = { id: string; name: string; code: string; role: string };

const ENTITY: Record<string, string> = {
  Order: 'Order',
  CashHandover: 'Handover',
  TillPayout: 'Payout',
  _User: 'Person',
  MenuItem: 'Dish',
  MenuCategory: 'Category',
  Accompaniment: 'Accompaniment',
  Shift: 'Shift',
  Configuration: 'Settings',
  ZReport: 'Z-report',
};

// Owner: who did what, with what changed.
export function AuditLog() {
  const { timezone } = useConfig();
  const navigate = useNavigate();
  const [filters, setFilters] = useFilters('last7');
  const [group, setGroup] = useState('');
  const [actorId, setActorId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data: setup } = useCloud<{ team: Person[] }>('adminListSetup', {});

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      try {
        const page: Page = await Parse.Cloud.run('adminGetAuditLog', {
          from: filters.from,
          to: filters.to,
          ...(group && { group }),
          ...(actorId && { actorId }),
          ...(before && { before }),
        });
        setRows((current) => (before ? [...current, ...page.rows] : page.rows));
        setNext(page.next);
        setGroups(page.groups);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the audit log');
      } finally {
        setBusy(false);
      }
    },
    [filters.from, filters.to, group, actorId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const when = (at: string) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const describe = (row: Row) =>
    changedFields(row.before, row.after)
      .map((c) =>
        c.before === null ? `${c.key}: ${c.after}` : `${c.key}: ${c.before} → ${c.after}`,
      )
      .join('; ');
  const exportCsv = () =>
    downloadCsv(
      `relay-audit-${filters.from}-to-${filters.to}`,
      ['When', 'Who', 'Action', 'Record', 'Changes'],
      rows.map((r) => [
        when(r.at),
        r.actor,
        actionLabel(r.action),
        `${ENTITY[r.entityType] || r.entityType} ${r.entity || r.entityId}`,
        describe(r),
      ]),
    );

  return (
    <div className={busy ? 'report busy' : 'report'}>
      <FilterBar filters={filters} onChange={setFilters}>
        <label>
          <span>Kind</span>
          <select aria-label="Kind" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Everything</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {AUDIT_GROUP_LABEL[g] || g}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Person</span>
          <select aria-label="Person" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            <option value="">Everyone</option>
            {(setup?.team ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {[p.code, p.name].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </label>
        <button className="filter-action" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </FilterBar>
      {error && <p className="ops-error">{error}</p>}
      <section className="admin-panel admin-section-panel">
        <div className="panel-title">
          <h2>
            Audit log{' '}
            <small>
              ({rows.length}
              {next ? '+' : ''})
            </small>
          </h2>
        </div>
        <p className="muted small">
          Every change made in Relay, newest first. Owner overrides are highlighted.
        </p>
        {rows.length ? (
          <div className="table-scroll">
            <table className="data stack-on-phone audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Record</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const changes = changedFields(r.before, r.after);
                  const isOrder = r.entityType === 'Order';
                  return (
                    <tr key={r.id} className={r.action.includes('override') ? 'highlight' : ''}>
                      <td data-label="When" className="nowrap">
                        {when(r.at)}
                      </td>
                      <td data-label="Who">{r.actor}</td>
                      <td data-label="What">{actionLabel(r.action)}</td>
                      <td data-label="Record">
                        {isOrder ? (
                          <button
                            className="link-button code"
                            onClick={() => navigate(`/admin/orders/${r.entityId}`)}
                          >
                            {r.entity || r.entityId}
                          </button>
                        ) : r.entityType === '_User' && r.entityId ? (
                          <button
                            className="link-button"
                            onClick={() => navigate(`/admin/team/${r.entityId}`)}
                          >
                            {r.entity || 'Person'}
                          </button>
                        ) : (
                          <>
                            {ENTITY[r.entityType] || r.entityType}
                            {r.entity && <small>{r.entity}</small>}
                          </>
                        )}
                      </td>
                      <td data-label="Changes" className="audit-changes">
                        {changes.length ? (
                          <ul>
                            {changes.slice(0, 8).map((c) => (
                              <li key={c.key}>
                                <b>{c.key}</b>{' '}
                                {c.before === null ? (
                                  c.after
                                ) : (
                                  <>
                                    <s>{c.before}</s> → {c.after}
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-orders">
            {busy ? 'Loading…' : 'Nothing recorded for these filters.'}
          </p>
        )}
        {next && (
          <div className="payment-actions load-more">
            <button className="setup-secondary" disabled={busy} onClick={() => void load(next)}>
              Load older entries
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
