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
export function ShiftPanel({ kind, preview }: { kind: 'rider' | 'cashier'; preview: boolean }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const [shift, setShift] = useState<Shift | null>(null),
    [opening, setOpening] = useState('0'),
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
      await Parse.Cloud.run('startShift', { kind, openingFloat: Number(opening) });
      await load();
      setNotice('Shift started.');
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
        physicalCount: Number(physical),
      });
      setShift(null);
      setNotice(
        kind === 'cashier' ? `Shift closed. Variance: ${money(result.variance)}.` : 'Shift closed.',
      );
      setPhysical('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close shift');
    } finally {
      setBusy(false);
    }
  };
  const outstanding = shift?.outstanding;
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
              busy || (kind === 'cashier' && physical === '') || (kind === 'rider' && riderBlocked)
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
              Opening cash in till
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
          )}
          <button className="shift-action" disabled={busy} onClick={() => void start()}>
            Start shift
          </button>
        </>
      )}
    </section>
  );
}
