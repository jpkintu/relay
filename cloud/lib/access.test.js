import { describe, expect, test } from 'vitest';
import { accessOf, addMonths } from './access.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T09:00:00Z');
const row = (fields) => ({ get: (key) => fields[key] });
const at = (days) => new Date(NOW + days * DAY);

describe('accessOf', () => {
  test('a trial is usable until it ends, then the grace days, then expired', () => {
    expect(accessOf(row({ trialEndsAt: at(3) }), 7, NOW)).toEqual({
      status: 'trial',
      ok: true,
      until: at(3),
    });
    expect(accessOf(row({ trialEndsAt: at(-2) }), 7, NOW)).toMatchObject({
      status: 'past_due',
      ok: true,
      until: at(5),
    });
    expect(accessOf(row({ trialEndsAt: at(-8) }), 7, NOW)).toMatchObject({
      status: 'expired',
      ok: false,
    });
    expect(accessOf(row({ trialEndsAt: at(-1) }), 0, NOW).status).toBe('expired');
  });
  test('the later of the trial end and the paid date counts', () => {
    expect(accessOf(row({ trialEndsAt: at(-20), paidUntil: at(10) }), 7, NOW)).toMatchObject({
      status: 'active',
      until: at(10),
    });
    // Paid during the trial: still a trial until the trial ends.
    expect(accessOf(row({ trialEndsAt: at(10), paidUntil: at(5) }), 7, NOW).status).toBe('trial');
  });
  test('suspension wins over everything', () => {
    expect(accessOf(row({ suspended: true, paidUntil: at(30) }), 7, NOW)).toEqual({
      status: 'suspended',
      ok: false,
      until: null,
    });
  });
  test('no dates at all is expired', () => {
    expect(accessOf(row({}), 7, NOW)).toEqual({ status: 'expired', ok: false, until: null });
  });
});

describe('addMonths', () => {
  test('same day next month, or the month’s last day', () => {
    expect(addMonths(new Date('2026-10-15T09:00:00Z'), 1).toISOString()).toBe(
      '2026-11-15T09:00:00.000Z',
    );
    expect(addMonths(new Date('2026-01-31T09:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T09:00:00.000Z',
    );
    expect(addMonths(new Date('2026-11-30T09:00:00Z'), 3).toISOString()).toBe(
      '2027-02-28T09:00:00.000Z',
    );
    expect(addMonths(new Date('2026-03-31T09:00:00Z'), 12).toISOString()).toBe(
      '2027-03-31T09:00:00.000Z',
    );
  });
});
