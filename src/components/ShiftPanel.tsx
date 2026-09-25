import { useCallback, useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import Parse from '../parse';

type Shift = {
  id: string;
  kind: string;
  startedAt: string;
  openingFloat: number;
  expectedTill: number | null;
  float: number | null;
};
export function ShiftPanel({ kind, preview }: { kind: 'rider' | 'cashier'; preview: boolean }) {
  const [shift, setShift] = useState<Shift | null>(null),
    [opening, setOpening] = useState('0'),
    [physical, setPhysical] = useState(''),
    [acknowledge, setAcknowledge] = useState(false),
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
        acknowledgeCash: acknowledge,
        physicalCount: Number(physical),
      });
      setShift(null);
      setNotice(
        kind === 'cashier'
          ? `Shift closed. Variance: UGX ${Number(result.variance).toLocaleString()}.`
          : 'Shift closed.',
      );
      setPhysical('');
      setAcknowledge(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close shift');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="shift-panel">
      <div className="shift-panel-title">
        <Clock3 />
        <div>
          <p className="eyebrow">Shift management</p>
          <h2>{shift ? 'Current shift' : 'Start your shift'}</h2>
        </div>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview ? (
        <p>Shift management requires a signed-in {kind}. Demo mode never changes cash balances.</p>
      ) : shift ? (
        <>
          <p>Started {new Date(shift.startedAt).toLocaleString()}</p>
          {kind === 'cashier' ? (
            <>
              <div className="shift-figures">
                <span>
                  Opening float <strong>UGX {shift.openingFloat.toLocaleString()}</strong>
                </span>
                <span>
                  Expected till{' '}
                  <strong>UGX {Number(shift.expectedTill || 0).toLocaleString()}</strong>
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
            <>
              <p>
                Cash still accountable:{' '}
                <strong>UGX {Number(shift.float || 0).toLocaleString()}</strong>
              </p>
              {Number(shift.float) > 0 && (
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                  />{' '}
                  I acknowledge that this cash is still with me and must be handed over.
                </label>
              )}
            </>
          )}
          <button
            className="shift-action"
            disabled={
              busy ||
              (kind === 'cashier' && physical === '') ||
              (kind === 'rider' && Number(shift.float) > 0 && !acknowledge)
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
