import { useCallback, useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { usePin } from '../lib/pin';

type Shift = {
  id: string;
  kind: string;
  startedAt: string;
  openingFloat: number;
  expectedTill: number | null;
  cashIn: number | null;
  counterCash?: number | null;
  paidOut: number | null;
  heldOrders: number | null;
  float: number | null;
  outstanding: {
    openOrders: number;
    cashWithRider: number;
    cashPending: number;
    momoPending?: number;
  } | null;
};
// "2 h 15 min" since the shift started.
function openFor(startedAt: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

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
  const withPin = usePin();
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
    setError('');
    let result: { variance: number } | null = null;
    const closed = await withPin('End your shift', async (pin) => {
      result = await Parse.Cloud.run('endShift', {
        shiftId: shift.id,
        physicalCount: kind === 'cashier' ? Number(physical) : undefined,
        varianceNote,
        pin,
      });
    });
    if (!closed) return;
    setShift(null);
    setNotice(
      kind === 'cashier' && result
        ? `Shift closed. Variance: ${money((result as { variance: number }).variance)}.`
        : 'Shift closed.',
    );
    setPhysical('');
    setVarianceNote('');
    onChanged?.();
  };
  const outstanding = shift?.outstanding;
  const difference =
    kind === 'cashier' && shift && physical !== ''
      ? Number(physical) - Number(shift.expectedTill || 0)
      : null;
  const riderBlocked =
    !!outstanding &&
    (outstanding.openOrders > 0 ||
      outstanding.cashWithRider > 0 ||
      outstanding.cashPending > 0 ||
      (outstanding.momoPending ?? 0) > 0);
  const endButton = (
    <button
      className="shift-action"
      disabled={
        busy ||
        (kind === 'cashier' &&
          (physical === '' ||
            Boolean(shift?.heldOrders) ||
            (!!difference && varianceNote.trim().length < 10))) ||
        (kind === 'rider' && riderBlocked)
      }
      onClick={() => void end()}
    >
      End shift
    </button>
  );
  return (
    <section className="shift-panel">
      <div className="shift-panel-title">
        <Clock3 />
        <div>
          <h2>{shift ? 'Current shift' : 'Start your shift'}</h2>
          {shift && (
            <p>
              Started {formatDate(shift.startedAt, timezone)} · open for {openFor(shift.startedAt)}
            </p>
          )}
        </div>
        {shift && <span className="shift-status">Open</span>}
      </div>
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview ? (
        <p>Shift management requires a signed-in {kind}. Demo mode never changes cash balances.</p>
      ) : shift ? (
        <>
          {kind === 'cashier' ? (
            <div className="till-layout">
              <div className="till-summary" aria-label="Till summary">
                <div className="till-line">
                  <span>Opening count</span>
                  <strong>{money(shift.openingFloat)}</strong>
                </div>
                <div className="till-line in">
                  <span>Cash in</span>
                  <strong>+ {money(shift.cashIn ?? 0)}</strong>
                  <small>
                    {money(Math.max(0, (shift.cashIn ?? 0) - (shift.counterCash ?? 0)))} from rider
                    handovers · {money(shift.counterCash ?? 0)} counter sales
                  </small>
                </div>
                <div className="till-line out">
                  <span>Paid out</span>
                  <strong>− {money(shift.paidOut ?? 0)}</strong>
                  <small>Commissions and delivery fees paid from the till</small>
                </div>
                <div className="till-line total">
                  <span>Expected in the till</span>
                  <strong>{money(shift.expectedTill)}</strong>
                </div>
              </div>
              <div className="till-close">
                <h3>Close your till</h3>
                {Boolean(shift.heldOrders) && (
                  <p className="till-warning">
                    You hold {shift.heldOrders} kitchen order{shift.heldOrders === 1 ? '' : 's'}.
                    Finish or transfer {shift.heldOrders === 1 ? 'it' : 'them'} before ending your
                    shift.
                  </p>
                )}
                <label className="setup-field till-count">
                  Count the cash in the till
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    value={physical}
                    onChange={(e) => setPhysical(e.target.value)}
                    placeholder="Counted amount"
                  />
                </label>
                {difference === null ? (
                  <p className="till-hint">
                    Enter what you counted to compare it with {money(shift.expectedTill)}.
                  </p>
                ) : difference === 0 ? (
                  <p className="till-difference ok">Till matches.</p>
                ) : (
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
                {endButton}
              </div>
            </div>
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
              {Boolean(outstanding?.momoPending) && (
                <li className="todo">
                  {outstanding!.momoPending} mobile money payment
                  {outstanding!.momoPending === 1 ? '' : 's'} waiting for the cashier to confirm
                </li>
              )}
              {Boolean(outstanding?.cashPending) && (
                <li className="todo">
                  {money(outstanding!.cashPending)} handed over, waiting for the cashier to confirm
                </li>
              )}
            </ul>
          )}
          {kind === 'rider' && endButton}
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
