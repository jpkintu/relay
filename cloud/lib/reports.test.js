import { describe, expect, test } from 'vitest';
import {
  accompanimentCounts,
  channelMix,
  growth,
  itemSales,
  paymentMix,
  riderStats,
  series,
  summarize,
  timeOfDay,
} from './reports.js';

const at = (iso) => new Date(iso);
const fact = (overrides) => ({
  status: 'DELIVERED',
  total: 28000,
  subtotal: 25000,
  deliveryFee: 3000,
  commission: 2000,
  method: 'cash',
  riderId: 'r1',
  rider: 'R-001 · Rita',
  customerKey: 'tel:0700',
  channel: 'phone',
  createdAt: at('2026-09-01T09:00:00Z'),
  deliveredAt: at('2026-09-01T09:40:00Z'),
  ...overrides,
});

describe('growth', () => {
  test('percentage change with one decimal', () => {
    expect(growth(150, 100)).toBe(50);
    expect(growth(90, 120)).toBe(-25);
    expect(growth(1, 3)).toBe(-66.7);
  });
  test('nothing to compare with', () => {
    expect(growth(100, 0)).toBeNull();
  });
});

describe('summarize', () => {
  test('counts revenue from delivered orders only', () => {
    const summary = summarize([
      fact({}),
      fact({ method: 'mobile_money', provider: 'mtn', customerKey: 'tel:0711' }),
      fact({ status: 'CANCELLED', commission: 0 }),
      fact({ status: 'PLACED', restaurantStatus: 'new' }),
      fact({ status: 'CANCELLED', restaurantStatus: 'rejected', customerKey: '' }),
    ]);
    expect(summary).toMatchObject({
      orders: 5,
      delivered: 2,
      cancelled: 2,
      rejected: 1,
      open: 1,
      revenue: 56000,
      foodSales: 50000,
      deliveryFees: 6000,
      commission: 4000,
      net: 52000,
      avgOrder: 28000,
      cashSales: 28000,
      mobileMoneySales: 28000,
      customers: 2,
      repeatCustomers: 0,
      avgDeliveryMinutes: 40,
    });
  });
  test('repeat customers and an empty period', () => {
    expect(summarize([fact({}), fact({})]).repeatCustomers).toBe(1);
    expect(summarize([])).toMatchObject({ revenue: 0, avgOrder: 0, avgDeliveryMinutes: null });
  });
});

test('series fills empty buckets and tracks change', () => {
  const rows = series(
    [fact({ key: 'a' }), fact({ key: 'c', total: 42000 }), fact({ key: 'c', status: 'PLACED' })],
    ['a', 'b', 'c'],
    (f) => f.key,
  );
  expect(rows.map((r) => [r.key, r.orders, r.revenue])).toEqual([
    ['a', 1, 28000],
    ['b', 0, 0],
    ['c', 2, 42000],
  ]);
  expect(rows[1].revenueChange).toBe(-100);
  expect(rows[2].revenueChange).toBeNull();
  expect(rows[2].avgOrder).toBe(42000);
});

test('item sales rank by revenue with share of sales', () => {
  const lines = [
    { name: 'Chicken stew', qty: 2, total: 50000, accompaniments: ['Matooke', 'Rice'] },
    { name: 'Chips', qty: 3, total: 15000, accompaniments: [] },
    { name: 'Chicken stew', qty: 1, total: 25000, accompaniments: ['Matooke'] },
  ];
  expect(itemSales(lines)).toEqual([
    { name: 'Chicken stew', qty: 3, revenue: 75000, orders: 2, share: 83.3, avgPrice: 25000 },
    { name: 'Chips', qty: 3, revenue: 15000, orders: 1, share: 16.7, avgPrice: 5000 },
  ]);
  expect(accompanimentCounts(lines)).toEqual([
    { name: 'Matooke', servings: 3 },
    { name: 'Rice', servings: 2 },
  ]);
});

test('rider stats', () => {
  const rows = riderStats([
    fact({}),
    fact({ status: 'CANCELLED' }),
    fact({ riderId: 'r2', rider: 'Ronald', total: 50000 }),
  ]);
  expect(rows[0]).toMatchObject({ riderId: 'r2', delivered: 1, revenue: 50000 });
  expect(rows[1]).toMatchObject({
    riderId: 'r1',
    orders: 2,
    delivered: 1,
    cancelled: 1,
    commission: 2000,
    avgDeliveryMinutes: 40,
  });
});

test('time of day, payment and channel mix', () => {
  const facts = [
    fact({ clock: { hour: 13, weekday: 4 } }),
    fact({ clock: { hour: 13, weekday: 5 }, method: 'mobile_money', provider: 'airtel' }),
    fact({ clock: { hour: 19, weekday: 5 }, status: 'CANCELLED', channel: 'walkin' }),
  ];
  const { hours, weekdays } = timeOfDay(facts, (f) => f.clock);
  expect(hours[13]).toEqual({ hour: 13, orders: 2, revenue: 56000 });
  expect(hours[19]).toEqual({ hour: 19, orders: 1, revenue: 0 });
  expect(weekdays[5].orders).toBe(2);
  expect(paymentMix(facts)).toEqual([
    { key: 'cash', orders: 1, amount: 28000 },
    { key: 'airtel', orders: 1, amount: 28000 },
  ]);
  expect(channelMix(facts)).toEqual([{ key: 'phone', orders: 2, amount: 56000 }]);
});
