import { describe, expect, test } from 'vitest';
import { deletionOf, deletionStep } from './retention.js';

const DAY = 86400000;
const NOW = new Date('2026-10-01T12:00:00Z').getTime();
const restaurant = (fields, createdAt = new Date(NOW - 200 * DAY)) => ({
  createdAt,
  get: (key) => fields[key],
});
const platform = { graceDays: 7, deleteAfterDays: 30, deleteWarnDays: 3 };
const ago = (days) => new Date(NOW - days * DAY);

describe('deleting restaurants that stopped paying', () => {
  test('paying, in a trial or in the grace days: never', () => {
    expect(deletionOf(restaurant({ paidUntil: ago(-5) }), platform, NOW)).toBeNull();
    expect(deletionOf(restaurant({ trialEndsAt: ago(-1) }), platform, NOW)).toBeNull();
    expect(deletionOf(restaurant({ paidUntil: ago(3) }), platform, NOW)).toBeNull();
  });

  test('closed 30 days after the grace days, warned 3 days before', () => {
    // Paid until 40 days ago: closed 33 days ago (7 grace days).
    const row = restaurant({ paidUntil: ago(40) });
    const state = deletionOf(row, platform, NOW);
    expect(state.closedAt).toEqual(ago(33));
    expect(state.deleteAt).toEqual(ago(3));
    expect(deletionStep(row, platform, NOW)).toBe('warn');
    // Closed 20 days ago: nothing yet.
    expect(deletionStep(restaurant({ paidUntil: ago(27) }), platform, NOW)).toBeNull();
    // Closed 28 days ago: warned now.
    expect(deletionStep(restaurant({ paidUntil: ago(35) }), platform, NOW)).toBe('warn');
  });

  test('deleted only once the notice has run since the warning', () => {
    const warnedToday = restaurant({ paidUntil: ago(100), deletionWarnedAt: ago(0) });
    expect(deletionStep(warnedToday, platform, NOW)).toBeNull();
    expect(deletionOf(warnedToday, platform, NOW).deleteAt).toEqual(ago(-3));
    const warnedEarlier = restaurant({ paidUntil: ago(100), deletionWarnedAt: ago(3) });
    expect(deletionStep(warnedEarlier, platform, NOW)).toBe('delete');
  });

  test('a warning from an earlier time it closed does not count', () => {
    // Warned 60 days ago, then paid; closed again 33 days ago.
    const row = restaurant({ paidUntil: ago(40), deletionWarnedAt: ago(60) });
    expect(deletionStep(row, platform, NOW)).toBe('warn');
  });

  test('never paid after choosing to pay at sign-up: counted from sign-up', () => {
    const row = restaurant({ payFirst: true }, ago(31));
    expect(deletionOf(row, platform, NOW).closedAt).toEqual(ago(31));
    expect(deletionStep(row, platform, NOW)).toBe('warn');
  });

  test('suspended, kept, already deleted, or switched off: never', () => {
    const lapsed = { paidUntil: ago(100), deletionWarnedAt: ago(10) };
    expect(deletionStep(restaurant({ ...lapsed, suspended: true }), platform, NOW)).toBeNull();
    expect(deletionStep(restaurant({ ...lapsed, neverDelete: true }), platform, NOW)).toBeNull();
    expect(deletionStep(restaurant({ ...lapsed, deleted: true }), platform, NOW)).toBeNull();
    expect(deletionStep(restaurant(lapsed), { ...platform, deleteAfterDays: 0 }, NOW)).toBeNull();
  });
});
