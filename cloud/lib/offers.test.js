import { describe as group, expect, test } from 'vitest';
import { discountFor, describe, cleanCode } from './offers.js';

group('offers', () => {
  const percent = { kind: 'percent', value: 20, minMonths: 1 };
  test('a percentage comes off the price of the period', () => {
    expect(discountFor(percent, 100000, 1)).toBe(20000);
    expect(discountFor(percent, 1000000, 12)).toBe(200000);
  });
  test('a fixed amount never leaves less than the smallest payment', () => {
    const amount = { kind: 'amount', value: 150000, minMonths: 1 };
    expect(discountFor(amount, 300000, 3)).toBe(150000);
    expect(discountFor(amount, 100000, 1)).toBe(99500);
  });
  test('a code for longer periods does nothing on shorter ones', () => {
    const yearly = { kind: 'percent', value: 10, minMonths: 12 };
    expect(discountFor(yearly, 300000, 3)).toBe(0);
    expect(discountFor(yearly, 1000000, 12)).toBe(100000);
  });
  test('no offer, no discount', () => {
    expect(discountFor(null, 100000, 1)).toBe(0);
  });
  test('described for people', () => {
    expect(describe(percent, 'UGX')).toBe('20% off your first payment');
    expect(describe({ kind: 'amount', value: 50000, minMonths: 12 }, 'UGX')).toBe(
      'UGX 50,000 off your first payment when paying a year',
    );
  });
  test('codes are cleaned to upper case', () => {
    expect(cleanCode(' launch 20! ')).toBe('LAUNCH20');
  });
});
