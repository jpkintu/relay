import { useEffect } from 'react';
import { useConfig, useMoney } from '../lib/session';
import { formatDate } from '../lib/format';
import { useCloud } from './reports/common';

export type MyHandover = {
  id: string;
  code: string;
  status: 'pending' | 'confirmed' | 'disputed';
  amount: number;
  orderCount: number;
  countedAmount: number | null;
  returnedAmount: number;
  returnedCount: number;
  disputeReason: string;
  resolution: string;
  resolutionNote: string;
  shortage: number;
  shortageStatus: string;
  handedOverAt: string;
  confirmedAt: string | null;
  receivedByOwner: boolean;
};

function handoverState(h: MyHandover, money: (n: number) => string) {
  if (h.status === 'pending') return { tone: 'warn', label: 'Waiting for the cashier' };
  if (h.status === 'disputed')
    return {
      tone: 'bad',
      label: `Disputed: counted ${money(h.countedAmount ?? 0)}. The owner will decide`,
    };
  if (h.shortageStatus === 'owed')
    return { tone: 'bad', label: `${money(h.shortage)} short, taken off your next pay` };
  if (h.shortageStatus === 'deducted')
    return { tone: 'good', label: `${money(h.shortage)} short, taken off your pay` };
  if (h.shortageStatus === 'written_off')
    return { tone: 'good', label: `${money(h.shortage)} short, written off by the owner` };
  if (h.returnedCount)
    return {
      tone: 'warn',
      label: `${money(h.amount - h.returnedAmount)} received · ${h.returnedCount} returned to you`,
    };
  return { tone: 'good', label: h.receivedByOwner ? 'Received by the owner' : 'Received' };
}

// Rider: recent handovers and where each one stands. `version` reloads it.
export function MyHandovers({ version }: { version: number }) {
  const money = useMoney();
  const { timezone } = useConfig();
  const { data, reload } = useCloud<MyHandover[]>('getMyHandovers', {});
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  if (!data?.length) return null;
  return (
    <section className="my-handovers">
      <h3>Your handovers</h3>
      {data.map((h) => {
        const state = handoverState(h, money);
        return (
          <article key={h.id} className={`my-handover ${state.tone}`}>
            <div>
              <b>{h.code}</b>
              <small>
                {formatDate(h.handedOverAt, timezone)} · {h.orderCount}{' '}
                {h.orderCount === 1 ? 'order' : 'orders'}
              </small>
            </div>
            <strong>{money(h.amount)}</strong>
            <p>{state.label}</p>
            {h.resolutionNote && <p className="muted">Owner: {h.resolutionNote}</p>}
          </article>
        );
      })}
    </section>
  );
}

type MyPayData = {
  deliveries: number;
  earned: number;
  deliveryFees: number;
  deductions: number;
  owed: number;
  payouts: { id: string; code: string; amount: number; paidBy: string; paidAt: string }[];
};

// Rider: what the restaurant owes them (commission + delivery fees) and
// recent payouts from the till.
export function MyPay() {
  const money = useMoney();
  const { timezone } = useConfig();
  const { data } = useCloud<MyPayData>('getMyPay', {});
  if (!data) return null;
  return (
    <section className="my-pay">
      <div className="cash-balance earnings owed">
        <p>Owed to you</p>
        <strong>{money(data.owed)}</strong>
        <span>
          {data.deliveries} unpaid {data.deliveries === 1 ? 'delivery' : 'deliveries'} ·{' '}
          {money(data.earned - data.deliveryFees)} commission + {money(data.deliveryFees)} delivery
          fees
          {data.deductions > 0 && ` · less ${money(data.deductions)} cash shortage`}
        </span>
        <small>The cashier pays you from the till.</small>
      </div>
      {data.payouts.length > 0 && (
        <div className="my-payouts">
          <h3>Recent pay</h3>
          {data.payouts.map((p) => (
            <div className="cash-order" key={p.id}>
              <span>
                {formatDate(p.paidAt, timezone)} · {p.paidBy}
              </span>
              <b>{money(p.amount)}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
