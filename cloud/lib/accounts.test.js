import { expect, test } from 'vitest';
import { balanceSheet, cashFlow, cashMovements, profitAndLoss } from './accounts.js';

// Two delivered orders: 25,000 food + 3,000 delivery each; rider pay 4,000
// (1,000 commission + the 3,000 fee). One paid, one cash still with the rider.
const orders = [
  {
    subtotal: 25000,
    deliveryFee: 3000,
    total: 28000,
    commission: 4000,
    deliveryPay: 3000,
    confirmed: true,
  },
  {
    subtotal: 25000,
    deliveryFee: 3000,
    total: 28000,
    commission: 4000,
    deliveryPay: 3000,
    confirmed: false,
  },
];
const purchases = [
  { total: 20000, paid: 20000, category: 'food' },
  { total: 10000, paid: 4000, category: 'drinks' },
];
const expenses = [
  { amount: 5000, category: 'utilities' },
  { amount: 2000, category: 'transport' },
];
const payouts = [
  { kind: 'rider', amount: 3000, deductions: 1000 },
  { kind: 'expense', amount: 500, deductions: 0 },
];

test('profit and loss', () => {
  const pl = profitAndLoss({ orders, purchases, expenses, tillExpenses: [{ amount: 500 }] });
  expect(pl.revenue).toEqual({ food: 50000, delivery: 6000, total: 56000, orders: 2 });
  expect(pl.costOfSales.total).toBe(30000);
  expect(pl.grossProfit).toBe(26000);
  expect(pl.operating).toMatchObject({
    riderCommission: 2000,
    riderDeliveryFees: 6000,
    fromTills: 500,
    total: 8000 + 7000 + 500,
  });
  expect(pl.operating.expenses[0]).toEqual({ key: 'utilities', amount: 5000 });
  expect(pl.netProfit).toBe(26000 - 15500);
  expect(pl.grossMargin).toBe(46.4);
});

test('cash flow: closing is opening plus what came in less what went out', () => {
  const movements = cashMovements({
    orders,
    supplierPayments: [{ amount: 20000 }, { amount: 4000 }],
    expenses,
    payouts,
  });
  expect(movements).toMatchObject({
    received: 28000,
    toSuppliers: 24000,
    onExpenses: 7000,
    riderPay: 3000,
    fromTills: 500,
    net: 28000 - 24000 - 7000 - 3000 - 500,
  });
  const flow = cashFlow({ opening: 100000, movements });
  expect(flow.closing).toBe(100000 - 6500);
});

test('the balance sheet balances, with differences shown', () => {
  const movements = cashMovements({
    orders,
    supplierPayments: [{ amount: 24000 }],
    expenses,
    payouts,
  });
  const profit = profitAndLoss({
    orders,
    purchases,
    expenses,
    tillExpenses: [{ amount: 500 }],
  }).netProfit;
  const sheet = balanceSheet({
    openingBalance: 100000,
    cash: 100000 + movements.net,
    orders,
    purchases,
    payouts,
    profit,
  });
  expect(sheet.assets).toEqual({ cash: 93500, receivable: 28000, total: 121500 });
  expect(sheet.liabilities).toEqual({ suppliers: 6000, riders: 4000, total: 10000 });
  expect(sheet.equity.total).toBe(sheet.assets.total - sheet.liabilities.total);
  // The 1,000 shortage taken off the rider's pay is the only difference.
  expect(sheet.equity.other).toBe(1000);
  expect(sheet.equity.opening + sheet.equity.profit + sheet.equity.other).toBe(sheet.equity.total);
});
