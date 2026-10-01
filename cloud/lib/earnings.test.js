import { describe, expect, test } from 'vitest';
import { earnedBetween, splitPayment, monthEarnings } from './earnings.js';

const at = (iso) => new Date(iso).getTime();
const OCT = [at('2026-10-01T00:00:00Z'), at('2026-11-01T00:00:00Z')];
const NOV = [at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z')];

// A year paid on 1 October 2026 (365 days).
const year = {
  amount: 1000000,
  paidAt: '2026-10-01T09:00:00Z',
  periodStart: '2026-10-01T00:00:00Z',
  periodEnd: '2027-10-01T00:00:00Z',
};
// A month paid mid-month: half in October, half in November.
const month = {
  amount: 100000,
  paidAt: '2026-10-16T10:00:00Z',
  periodStart: '2026-10-16T12:00:00Z',
  periodEnd: '2026-11-16T12:00:00Z',
};

describe('earnings', () => {
  test('a year is earned day by day: 31 of 365 days in October', () => {
    const split = splitPayment(year, ...OCT);
    expect(split.earnedInMonth).toBe(Math.round((1000000 * 31) / 365));
    expect(split.earnedBefore).toBe(0);
    expect(split.earnedBefore + split.earnedInMonth + split.deferredAfter).toBe(1000000);
  });

  test('the shares always add up to the amount', () => {
    for (const range of [OCT, NOV]) {
      const s = splitPayment(month, ...range);
      expect(s.earnedBefore + s.earnedInMonth + s.deferredAfter).toBe(100000);
    }
  });

  test('a payment without a period is earned when paid', () => {
    const old = { amount: 50000, paidAt: '2026-10-05T00:00:00Z' };
    expect(earnedBetween(old, ...OCT)).toBe(50000);
    expect(earnedBetween(old, ...NOV)).toBe(0);
  });

  test('a month: received, earned, deferred and the prepayment balance', () => {
    const oct = monthEarnings([year, month], ...OCT);
    expect(oct.totals.received).toBe(1100000);
    expect(oct.totals.earned).toBe(oct.totals.earnedFromThisMonth);
    expect(oct.totals.earnedFromEarlier).toBe(0);
    expect(oct.totals.earned + oct.totals.deferredFromThisMonth).toBe(1100000);
    expect(oct.totals.prepaidAtEnd).toBe(oct.totals.deferredFromThisMonth);

    const nov = monthEarnings([year, month], ...NOV);
    expect(nov.totals.received).toBe(0);
    expect(nov.totals.earnedFromThisMonth).toBe(0);
    expect(nov.totals.earnedFromEarlier).toBe(nov.totals.earned);
    // What was prepaid at October's end is earned in November or still prepaid.
    expect(nov.totals.earned + nov.totals.prepaidAtEnd).toBe(oct.totals.prepaidAtEnd);
    expect(nov.rows.every((row) => !row.paidInMonth)).toBe(true);
  });

  test('payments after the month are left out', () => {
    const later = { ...month, paidAt: '2026-11-02T00:00:00Z' };
    expect(monthEarnings([later], ...OCT).rows).toEqual([]);
  });
});
