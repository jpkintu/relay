import { describe, expect, test } from 'vitest';
import { computeCommission, riderPay, roundCommission, sumBy } from './money.js';

describe('computeCommission', () => {
  test('per_order pays the flat fee regardless of subtotal', () => {
    expect(
      computeCommission({ type: 'per_order', perOrder: 2000, percent: 10, subtotal: 50000 }),
    ).toBe(2000);
  });

  test('percent pays a share of the subtotal', () => {
    expect(
      computeCommission({ type: 'percent', perOrder: 2000, percent: 5, subtotal: 37000 }),
    ).toBe(1850);
  });

  test('hybrid pays the base plus the share', () => {
    expect(
      computeCommission({ type: 'hybrid', perOrder: 1000, percent: 10, subtotal: 37000 }),
    ).toBe(4700);
  });

  test('unknown or missing values fall back to a flat fee of zero', () => {
    expect(computeCommission({ type: undefined, subtotal: 10000 })).toBe(0);
    expect(computeCommission({ type: 'percent', percent: undefined, subtotal: 10000 })).toBe(0);
  });

  test('applies commission rounding', () => {
    expect(
      computeCommission({ type: 'percent', percent: 7, subtotal: 12345, rounding: 'up_100' }),
    ).toBe(900);
  });
});

describe('roundCommission', () => {
  test('rounds to whole units by default', () => {
    expect(roundCommission(864.5)).toBe(865);
    expect(roundCommission(864.4, 'none')).toBe(864);
  });

  test('rounds up to the configured step', () => {
    expect(roundCommission(1001, 'up_500')).toBe(1500);
    expect(roundCommission(1000, 'up_1000')).toBe(1000);
    expect(roundCommission(1000.2, 'up_1000')).toBe(1000);
  });
});

test('sumBy ignores missing values', () => {
  expect(sumBy([{ a: 1 }, { a: '2' }, {}], (row) => row.a)).toBe(3);
});

describe('riderPay', () => {
  test('is the stored amount when it already includes the delivery fee', () => {
    expect(riderPay({ commissionAmount: 4000, deliveryPay: 3000, deliveryFee: 3000 })).toBe(4000);
  });

  test('adds the delivery fee for orders stored with commission only', () => {
    expect(riderPay({ commissionAmount: 3000, deliveryFee: 3000 })).toBe(6000);
    expect(riderPay({ commissionAmount: 0, deliveryFee: 2000 })).toBe(2000);
  });
});
