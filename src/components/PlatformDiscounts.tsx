import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Parse from '../parse';
import { formatDate, formatMoney } from '../lib/format';

// Relay Hosted, platform console: discount codes for a restaurant's first
// payment when it pays at sign-up instead of a free trial (cloud/offers.js).
// Referral codes need nothing here: any restaurant's own code works, with
// the referral discount and reward from Platform settings.

type Code = {
  id: string;
  code: string;
  kind: 'percent' | 'amount';
  value: number;
  minMonths: number;
  maxUses: number | null;
  used: number;
  expiresAt: string | null;
  active: boolean;
  note: string;
  given: number;
};
type Draft = {
  id?: string;
  code: string;
  kind: 'percent' | 'amount';
  value: string;
  minMonths: string;
  maxUses: string;
  expiresAt: string;
  active: boolean;
  note: string;
};

const EMPTY: Draft = {
  code: '',
  kind: 'percent',
  value: '',
  minMonths: '1',
  maxUses: '',
  expiresAt: '',
  active: true,
  note: '',
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PlatformDiscounts({
  currency,
  timeZone,
  referralPercent,
  referralMonths,
}: {
  currency: string;
  timeZone: string;
  referralPercent: number;
  referralMonths: number;
}) {
  const [rows, setRows] = useState<Code[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await Parse.Cloud.run('platformListDiscountCodes')).rows);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const edit = (row: Code) =>
    setDraft({
      id: row.id,
      code: row.code,
      kind: row.kind,
      value: String(row.value),
      minMonths: String(row.minMonths),
      maxUses: row.maxUses === null ? '' : String(row.maxUses),
      expiresAt: row.expiresAt ? row.expiresAt.slice(0, 10) : '',
      active: row.active,
      note: row.note,
    });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('platformSaveDiscountCode', {
        ...draft,
        value: Number(draft.value),
        minMonths: Number(draft.minMonths),
        maxUses: draft.maxUses.trim() === '' ? null : Number(draft.maxUses),
        // The end of that day.
        expiresAt: draft.expiresAt ? `${draft.expiresAt}T23:59:59` : null,
      });
      setDraft(null);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => (d ? { ...d, [key]: e.target.value } : d));
  const off = (row: Code) =>
    row.kind === 'percent' ? `${row.value}% off` : `${formatMoney(row.value, currency)} off`;

  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>Codes</h2>
          <p className="muted">
            Discount codes for the first payment of a restaurant that chooses to pay at sign-up
            instead of a free trial. Any restaurant&apos;s own code also works there as a referral:{' '}
            {referralPercent > 0
              ? `the new restaurant gets ${referralPercent}% off and the one that referred it ${referralMonths} free month${referralMonths === 1 ? '' : 's'} once it has paid`
              : 'referrals are off'}{' '}
            (Platform settings).
          </p>
        </div>
        {!draft && (
          <button className="secondary-button" onClick={() => setDraft({ ...EMPTY })}>
            New code
          </button>
        )}
      </div>

      {draft && (
        <form className="platform-form" onSubmit={(e) => void save(e)}>
          <label className="setup-field">
            Code
            <input
              value={draft.code}
              onChange={set('code')}
              placeholder="e.g. LAUNCH20"
              autoCapitalize="characters"
              required
            />
          </label>
          <label className="setup-field">
            Discount
            <select value={draft.kind} onChange={set('kind')}>
              <option value="percent">Percent off</option>
              <option value="amount">Amount off ({currency})</option>
            </select>
          </label>
          <label className="setup-field">
            {draft.kind === 'percent' ? 'Percent (1–90)' : `Amount (${currency})`}
            <input inputMode="numeric" value={draft.value} onChange={set('value')} required />
          </label>
          <label className="setup-field">
            Only when paying at least
            <select value={draft.minMonths} onChange={set('minMonths')}>
              <option value="1">Any period</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">A year</option>
            </select>
          </label>
          <label className="setup-field">
            Uses (empty: no limit)
            <input inputMode="numeric" value={draft.maxUses} onChange={set('maxUses')} />
          </label>
          <label className="setup-field">
            Expires (empty: never)
            <input type="date" value={draft.expiresAt} onChange={set('expiresAt')} />
          </label>
          <label className="setup-field platform-note">
            Note (for you)
            <input value={draft.note} onChange={set('note')} placeholder="e.g. Kampala food fair" />
          </label>
          <label className="setup-checkbox platform-note">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft((d) => (d ? { ...d, active: e.target.checked } : d))}
            />{' '}
            Active
          </label>
          {error && <p className="form-error platform-note">{error}</p>}
          <div className="platform-actions platform-note">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : draft.id ? 'Save code' : 'Create code'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!draft && error && <p className="form-error">{error}</p>}
      {rows && rows.length > 0 ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Discount</th>
                <th className="num">Used</th>
                <th>Expires</th>
                <th className="num">Given</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <b>{row.code}</b>
                    {!row.active && <small className="muted block">Off</small>}
                    {row.note && <small className="muted block">{row.note}</small>}
                  </td>
                  <td>
                    {off(row)}
                    {row.minMonths > 1 && (
                      <small className="muted block">
                        {row.minMonths === 12 ? 'a year only' : `${row.minMonths} months or more`}
                      </small>
                    )}
                  </td>
                  <td className="num">
                    {row.used}
                    {row.maxUses !== null ? ` of ${row.maxUses}` : ''}
                  </td>
                  <td>
                    {row.expiresAt
                      ? formatDate(row.expiresAt, timeZone, { dateStyle: 'medium' })
                      : 'Never'}
                  </td>
                  <td className="num">{formatMoney(row.given, currency)}</td>
                  <td className="actions-cell">
                    <button className="link-button" onClick={() => edit(row)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        rows && !draft && <p className="muted">No codes yet.</p>
      )}
    </section>
  );
}
