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
  tillTrend,
} from './reports.js';

const at = (iso) => new Date(iso);
const fact = (overrides) => ({
  status: 'DELIVERED',
  total: 28000,
  subtotal: 25000,
  deliveryFee: 3000,
  commission: 2000,
  method: 'cash',
  cashStatus: 'RECONCILED',
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
      fact({
        method: 'mobile_money',
        provider: 'mtn',
        paymentStatus: 'VERIFIED',
        customerKey: 'tel:0711',
      }),
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
      riderCommission: -2000,
      net: 52000,
      avgOrder: 28000,
      cashSales: 28000,
      mobileMoneySales: 28000,
      unconfirmedSales: 0,
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
    { name: 'Matooke', servings: 3, revenue: 0 },
    { name: 'Rice', servings: 2, revenue: 0 },
  ]);
});

test('charged accompaniments count what they brought in', () => {
  const lines = [
    {
      name: 'Chicken stew',
      qty: 2,
      total: 54000,
      accompaniments: ['Chips', 'Rice'],
      accompanimentPrices: [2000, 0],
    },
    { name: 'Fish', qty: 1, total: 32000, accompaniments: ['Chips'], accompanimentPrices: [2000] },
  ];
  expect(accompanimentCounts(lines)).toEqual([
    { name: 'Chips', servings: 3, revenue: 6000 },
    { name: 'Rice', servings: 2, revenue: 0 },
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
    fact({
      clock: { hour: 13, weekday: 5 },
      method: 'mobile_money',
      provider: 'airtel',
      paymentStatus: 'VERIFIED',
    }),
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

test('only confirmed money counts in the payment mix', () => {
  const facts = [
    fact({}),
    fact({ cashStatus: 'WITH_RIDER' }),
    fact({ cashStatus: 'HANDOVER_PENDING' }),
    fact({ method: 'mobile_money', provider: 'mtn', paymentStatus: 'VERIFIED' }),
    fact({ method: 'mobile_money', provider: 'airtel', paymentStatus: 'PENDING_VERIFICATION' }),
    fact({ method: 'card', provider: 'card', paymentStatus: 'VERIFIED' }),
    fact({ method: 'card', provider: 'card', paymentStatus: 'PENDING_VERIFICATION' }),
  ];
  expect(paymentMix(facts)).toEqual([
    { key: 'cash', orders: 1, amount: 28000 },
    { key: 'mtn', orders: 1, amount: 28000 },
    { key: 'card', orders: 1, amount: 28000 },
  ]);
  const summary = summarize(facts);
  expect(summary.cashSales).toBe(28000);
  expect(summary.mobileMoneySales).toBe(28000);
  expect(summary.cardSales).toBe(28000);
  expect(summary.unconfirmedSales).toBe(4 * 28000);
});

test('rider pay splits into commission and the delivery fee passed on', () => {
  // 25,000 food + 3,000 fee; rider pay 3,925 = 925 commission + 3,000 fee.
  const summary = summarize([fact({ commission: 3925, deliveryPay: 3000 })]);
  expect(summary.revenue).toBe(28000);
  expect(summary.foodSales).toBe(25000);
  expect(summary.riderCommission).toBe(925);
  expect(summary.net).toBe(25000 - 925);
});

describe('counter orders (eat in, pick up, call-in delivery)', () => {
  const eatIn = fact({
    orderType: 'eat_in',
    source: 'counter',
    riderId: '',
    rider: '',
    deliveryFee: 0,
    deliveryPay: 0,
    commission: 0,
    total: 30000,
    subtotal: 30000,
    customerKey: '',
    cashStatus: 'IN_TILL',
    createdAt: at('2026-09-01T12:00:00Z'),
    deliveredAt: at('2026-09-01T12:20:00Z'),
  });
  const rider = fact({ deliveryPay: 3000, commission: 5000 });
  const callIn = fact({ source: 'counter', commission: 3000, deliveryPay: 3000 });

  test('sales split by who took the order; till cash counts as confirmed', () => {
    const s = summarize([rider, callIn, eatIn]);
    expect(s.revenue).toBe(28000 + 28000 + 30000);
    expect(s.counterSales).toBe(28000 + 30000);
    expect(s.riderSales).toBe(28000);
    expect(s.net).toBe(s.revenue - (5000 + 3000));
    expect(s.riderCommission).toBe(2000);
    expect(s.cashSales).toBe(s.revenue);
  });
  test('order-to-door time is for deliveries only', () => {
    const s = summarize([rider, eatIn]);
    expect(s.avgDeliveryMinutes).toBe(40);
    expect(s.avgCounterMinutes).toBe(20);
  });
  test('walk-in guests are not counted as customers', () => {
    const s = summarize([rider, eatIn, { ...eatIn }]);
    expect(s.customers).toBe(1);
    expect(s.repeatCustomers).toBe(0);
  });
  test('orders by kind', () => {
    expect(summarize([rider, callIn, eatIn]).byType).toEqual([
      { key: 'delivery', orders: 2, amount: 56000 },
      { key: 'eat_in', orders: 1, amount: 30000 },
      { key: 'pickup', orders: 0, amount: 0 },
    ]);
  });
  test('riders are ranked on their own deliveries only', () => {
    expect(riderStats([rider, eatIn]).map((r) => r.riderId)).toEqual(['r1']);
  });
});

test('till differences by day and by cashier', () => {
  const trend = tillTrend([
    { day: '2026-09-26', cashier: 'Carol', variance: -2000 },
    { day: '2026-09-26', cashier: 'Dan', variance: 500 },
    { day: '2026-09-27', cashier: 'Carol', variance: -5000 },
    { day: '2026-09-27', cashier: 'Dan', variance: 0 },
    { day: '2026-09-27', cashier: 'Eve', variance: null },
  ]);
  expect(trend.closedShifts).toBe(4);
  expect(trend.shortShifts).toBe(2);
  expect(trend.days).toEqual([
    { day: '2026-09-26', shifts: 2, short: 2000, over: 500, net: -1500, worst: -2000 },
    { day: '2026-09-27', shifts: 2, short: 5000, over: 0, net: -5000, worst: -5000 },
  ]);
  expect(trend.cashiers[0]).toEqual({
    cashier: 'Carol',
    shifts: 2,
    short: 7000,
    over: 0,
    net: -7000,
    worst: -5000,
  });
});
