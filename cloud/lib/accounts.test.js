import { expect, test } from 'vitest';
import { cashFlowStatement, position, profitAndLoss, ratios } from './accounts.js';

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

test('equipment bought is a fixed asset, not an expense', () => {
  const pl = profitAndLoss({
    orders,
    purchases,
    expenses: [...expenses, { amount: 40000, category: 'equipment' }],
    tillExpenses: [],
  });
  expect(pl.operating.expenses.map((e) => e.key)).not.toContain('equipment');
  expect(pl.netProfit).toBe(
    profitAndLoss({ orders, purchases, expenses, tillExpenses: [] }).netProfit,
  );
});

// One restaurant's books: 100,000 opening (60,000 cash, 40,000 mobile money /
// bank); the two orders above (one paid in cash, one still with the rider);
// purchases with one supplier paid in cash and one part paid by mobile
// money; expenses by cash and bank; a rider payout and a till expense; a
// voucher (18,500 came in by mobile money, still owed).
const books = {
  orders: [
    { ...orders[0], method: 'cash' },
    { ...orders[1], method: 'cash' },
  ],
  purchases: [
    { total: 20000, paid: 20000, payments: [{ amount: 20000, method: 'cash' }] },
    { total: 10000, paid: 4000, payments: [{ amount: 4000, method: 'mobile_money' }] },
  ],
  expenses: [
    { amount: 5000, category: 'utilities', method: 'bank' },
    { amount: 2000, category: 'transport', method: 'cash' },
    { amount: 30000, category: 'equipment', method: 'bank' },
  ],
  payouts,
  vouchers: [{ cashIn: 18500, owed: 18500, refunded: false, sent: 0, charges: 0 }],
  opening: { cash: 60000, bank: 40000 },
};

test('the balance sheet: cash and bank by how money moved, and it balances', () => {
  const profit = profitAndLoss({
    orders,
    purchases,
    expenses: books.expenses,
    tillExpenses: [{ amount: 500 }],
  }).netProfit;
  const sheet = position({ ...books, profit: { toDate: profit, beforeYear: 5000 } });
  // Cash: 60,000 + 28,000 sale − 20,000 supplier − 2,000 − 3,500 payouts.
  expect(sheet.assets.tills).toBe(62500);
  // Bank: 40,000 + 18,500 voucher − 4,000 supplier − 5,000 − 30,000 equipment.
  expect(sheet.assets.bank).toBe(19500);
  expect(sheet.assets.receivable).toBe(28000);
  expect(sheet.assets.equipment).toBe(30000);
  expect(sheet.assets.total).toBe(62500 + 19500 + 28000 + 30000);
  expect(sheet.liabilities).toEqual({
    suppliers: 6000,
    riders: 4000,
    refunds: 18500,
    current: 28500,
    total: 28500,
  });
  expect(sheet.equity.opening).toBe(100000);
  expect(sheet.equity.retained).toBe(5000);
  expect(sheet.equity.currentYear).toBe(profit - 5000);
  // The 1,000 shortage taken off the rider's pay is the only difference.
  expect(sheet.equity.other).toBe(1000);
  expect(sheet.equity.total).toBe(sheet.assets.total - sheet.liabilities.total);
});

test('the cash flow statement (indirect) ties net income to the change in cash', () => {
  const empty = position({
    orders: [],
    purchases: [],
    expenses: [],
    payouts: [],
    vouchers: [],
    opening: books.opening,
    profit: { toDate: 0, beforeYear: 0 },
  });
  const pl = profitAndLoss({
    orders,
    purchases,
    expenses: books.expenses,
    tillExpenses: [{ amount: 500 }],
  });
  const end = position({ ...books, profit: { toDate: pl.netProfit, beforeYear: 0 } });
  const flow = cashFlowStatement({ start: empty, end, netProfit: pl.netProfit });
  expect(flow.beginning).toBe(100000);
  expect(flow.operating.netIncome).toBe(pl.netProfit);
  const line = (key) => flow.operating.lines.find((l) => l.key === key).amount;
  expect(line('receivable')).toBe(-28000);
  expect(line('payable')).toBe(6000);
  expect(line('vouchers')).toBe(18500);
  expect(flow.investing.total).toBe(-30000);
  expect(flow.financing.total).toBe(0);
  expect(flow.beginning + flow.netChange).toBe(flow.ending);
  expect(flow.ending).toBe(end.assets.cash);
});

test('performance ratios', () => {
  const pl = profitAndLoss({ orders, purchases, expenses, tillExpenses: [] });
  const pos = position({ ...books, profit: { toDate: pl.netProfit, beforeYear: 0 } });
  const r = ratios({ pl, position: pos, receivableBefore: 0 });
  expect(r.grossProfit).toBe(Math.round((pl.grossProfit / pl.revenue.total) * 100) / 100);
  expect(r.current).toBe(Math.round((pos.assets.current / pos.liabilities.current) * 100) / 100);
  expect(r.receivableTurnover).toBe(Math.round((56000 / 14000) * 100) / 100);
  expect(
    ratios({
      pl: profitAndLoss({ orders: [], purchases: [], expenses: [], tillExpenses: [] }),
      position: pos,
    }).grossProfit,
  ).toBe(null);
});

test('stock counted: cost of goods sold, an asset, a cash flow line and the acid test', () => {
  // 30,000 bought; 8,000 on hand at the start (counted earlier), 12,000 at
  // the end: 26,000 of it was used.
  const pl = profitAndLoss({
    orders,
    purchases,
    expenses,
    tillExpenses: [],
    stockStart: 8000,
    stockEnd: 12000,
  });
  expect(pl.costOfSales).toMatchObject({
    purchases: 30000,
    openingStock: 8000,
    closingStock: 12000,
    total: 26000,
  });
  expect(pl.grossProfit).toBe(56000 - 26000);
  const base = { profit: { toDate: 0, beforeYear: 0 } };
  const before = position({ ...books, ...base, inventory: 8000 });
  const after = position({ ...books, ...base, inventory: 12000 });
  expect(after.assets.inventory).toBe(12000);
  expect(after.assets.current - before.assets.current).toBe(4000);
  expect(after.assets.total).toBe(position({ ...books, ...base }).assets.total + 12000);
  const flow = cashFlowStatement({ start: before, end: after, netProfit: 0 });
  expect(flow.operating.lines.find((l) => l.key === 'inventory').amount).toBe(-4000);
  const r = ratios({ pl, position: after });
  expect(r.acidTest).toBe(
    Math.round(((after.assets.current - 12000) / after.liabilities.current) * 100) / 100,
  );
  expect(r.acidTest).toBeLessThan(r.current);
});
