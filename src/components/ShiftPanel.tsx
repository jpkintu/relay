import { useCallback, useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';

type Shift = {
  id: string;
  kind: string;
  startedAt: string;
  openingFloat: number;
  expectedTill: number | null;
  float: number | null;
  outstanding: { openOrders: number; cashWithRider: number; cashPending: number } | null;
};
export function ShiftPanel({
  kind,
  preview,
  onChanged,
}: {
  kind: 'rider' | 'cashier';
  preview: boolean;
  // Called after the shift starts or ends.
  onChanged?: () => void;
}) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [shift, setShift] = useState<Shift | null>(null),
    [opening, setOpening] = useState(''),
    [varianceNote, setVarianceNote] = useState(''),
    [physical, setPhysical] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const data = await Parse.Cloud.run('getMyShift');
      setShift(data.shift);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load shift');
    }
  }, [preview]);
  useEffect(() => {
    void load();
  }, [load]);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('startShift', {
        kind,
        openingFloat: kind === 'cashier' ? Number(opening) : 0,
      });
      await load();
      setNotice('Shift started.');
      setOpening('');
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start shift');
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    if (!shift) return;
    setBusy(true);
    setError('');
    try {
      const result = await Parse.Cloud.run('endShift', {
        shiftId: shift.id,
        physicalCount: kind === 'cashier' ? Number(physical) : undefined,
        varianceNote,
      });
      setShift(null);
      setNotice(
        kind === 'cashier' ? `Shift closed. Variance: ${money(result.variance)}.` : 'Shift closed.',
      );
      setPhysical('');
      setVarianceNote('');
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close shift');
    } finally {
      setBusy(false);
    }
  };
  const outstanding = shift?.outstanding;
  const difference =
    kind === 'cashier' && shift && physical !== ''
      ? Number(physical) - Number(shift.expectedTill || 0)
      : null;
  const riderBlocked =
    !!outstanding &&
    (outstanding.openOrders > 0 || outstanding.cashWithRider > 0 || outstanding.cashPending > 0);
  return (
    <section className="shift-panel">
      <div className="shift-panel-title">
        <Clock3 />
        <div>
          <h2>{shift ? 'Current shift' : 'Start your shift'}</h2>
        </div>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview ? (
        <p>Shift management requires a signed-in {kind}. Demo mode never changes cash balances.</p>
      ) : shift ? (
        <>
          <p>Started {formatDate(shift.startedAt, timezone)}</p>
          {kind === 'cashier' ? (
            <>
              <div className="shift-figures">
                <span>
                  Opening float <strong>{money(shift.openingFloat)}</strong>
                </span>
                <span>
                  Expected till <strong>{money(shift.expectedTill)}</strong>
                </span>
              </div>
              <label className="setup-field">
                Physical till count
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={physical}
                  onChange={(e) => setPhysical(e.target.value)}
                  placeholder="Enter counted amount"
                />
              </label>
              {difference !== null && difference !== 0 && (
                <>
                  <p className={`till-difference ${difference < 0 ? 'short' : 'over'}`}>
                    Till {difference < 0 ? 'short' : 'over'} by {money(Math.abs(difference))}
                  </p>
                  <label className="setup-field">
                    Explain the difference (the owner sees this)
                    <textarea
                      value={varianceNote}
                      onChange={(e) => setVarianceNote(e.target.value)}
                      maxLength={500}
                      rows={3}
                      placeholder="e.g. Gave change twice to one customer"
                    />
                  </label>
                </>
              )}
              {difference === 0 && <p className="till-difference ok">Till matches.</p>}
            </>
          ) : (
            <ul className="shift-checklist" aria-label="Before you end your shift">
              <li className={outstanding?.openOrders ? 'todo' : 'done'}>
                {outstanding?.openOrders
                  ? `${outstanding.openOrders} open order${outstanding.openOrders === 1 ? '' : 's'} to deliver or cancel`
                  : 'No open orders'}
              </li>
              <li className={outstanding?.cashWithRider ? 'todo' : 'done'}>
                {outstanding?.cashWithRider
                  ? `${money(outstanding.cashWithRider)} cash to hand over`
                  : 'No cash in hand'}
              </li>
              {Boolean(outstanding?.cashPending) && (
                <li className="todo">
                  {money(outstanding!.cashPending)} handed over, waiting for the cashier to confirm
                </li>
              )}
            </ul>
          )}
          <button
            className="shift-action"
            disabled={
              busy ||
              (kind === 'cashier' &&
                (physical === '' || (!!difference && varianceNote.trim().length < 10))) ||
              (kind === 'rider' && riderBlocked)
            }
            onClick={() => void end()}
          >
            End shift
          </button>
        </>
      ) : (
        <>
          {kind === 'cashier' && (
            <label className="setup-field">
              Cash in the till now (count it)
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={opening}
                placeholder="e.g. 50000"
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
          )}
          <button
            className="shift-action"
            disabled={busy || (kind === 'cashier' && opening === '')}
            onClick={() => void start()}
          >
            Start shift
          </button>
        </>
      )}
    </section>
  );
}
