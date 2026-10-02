// The accounting statements (Admin → Accounting), as pure functions of plain
// records so the maths can be unit-tested. accounting.js loads the records.
//
// Relay keeps no general ledger; the statements are worked out from what the
// app records, on these rules (accrual basis):
// - Revenue is earned when an order is delivered or served: food sales plus
//   delivery fees.
// - Stock bought is a cost of goods sold when it is bought (no stock counts).
// - Rider pay (commission plus the delivery fees passed on) is an operating
//   expense when the order is delivered; it is owed until paid out.
// - Equipment (the expense kind) is a fixed asset at cost, not an expense
//   (no depreciation is worked out).
// - Cash (tills) and mobile money / bank are worked out: the opening
//   balances the owner enters, plus money received (cash counted in, mobile
//   money and card confirmed), less what was paid out, by how it was paid.
// - Owed to the restaurant: sales not yet received (cash with riders,
//   payments being checked, open bills). Owed by it: unpaid purchases
//   (accounts payable), unpaid rider pay and customers' vouchers (money paid
//   for cancelled orders, vouchers.js).
// - Equity: the opening balance, profit of earlier financial years (retained
//   earnings) and of this one, and cash over / short (till and cash
//   differences) that makes the books balance.

const round = (value) => Math.round(Number(value) || 0);
const sum = (rows, pick) => rows.reduce((n, row) => n + round(pick(row)), 0);

function byKey(rows, key, amount) {
  const out = {};
  for (const row of rows) out[row[key]] = (out[row[key]] || 0) + round(amount(row));
  return Object.entries(out)
    .map(([k, value]) => ({ key: k, amount: value }))
    .sort((a, b) => b.amount - a.amount);
}

// Equipment bought is a fixed asset, not an expense.
const isAsset = (expense) => expense.category === 'equipment';
const inCash = (method) => !method || method === 'cash';

// orders: delivered order facts ({ subtotal, deliveryFee, total, commission,
//   deliveryPay }); purchases: { total, category }; expenses: { amount,
//   category }; tillExpenses: { amount } (paid from a cashier's till).
function profitAndLoss({ orders, purchases, expenses, tillExpenses }) {
  const food = sum(orders, (o) => o.subtotal);
  const delivery = sum(orders, (o) => o.deliveryFee);
  const revenue = food + delivery;
  const costOfSales = sum(purchases, (p) => p.total);
  const grossProfit = revenue - costOfSales;
  const riderPay = sum(orders, (o) => o.commission);
  const riderDeliveryFees = sum(orders, (o) => o.deliveryPay ?? o.deliveryFee);
  const running = expenses.filter((e) => !isAsset(e));
  const expenseRows = byKey(running, 'category', (e) => e.amount);
  const fromTills = sum(tillExpenses, (e) => e.amount);
  const operating = riderPay + sum(running, (e) => e.amount) + fromTills;
  const netProfit = grossProfit - operating;
  return {
    revenue: { food, delivery, total: revenue, orders: orders.length },
    costOfSales: { byCategory: byKey(purchases, 'category', (p) => p.total), total: costOfSales },
    grossProfit,
    operating: {
      riderCommission: riderPay - riderDeliveryFees,
      riderDeliveryFees,
      expenses: expenseRows,
      fromTills,
      total: operating,
    },
    netProfit,
    grossMargin: revenue ? Math.round((grossProfit / revenue) * 1000) / 10 : null,
    netMargin: revenue ? Math.round((netProfit / revenue) * 1000) / 10 : null,
  };
}

// Paid for a sale: its total less any voucher (money that came in earlier).
const paidOf = (o) => round(o.total) - round(o.voucher || 0);

// The financial position at a moment, from everything recorded before it.
// orders: delivered order facts { …, confirmed, method }; purchases:
// { total, paid } as at that day, with `payments` [{ amount, method }] made
// by then; expenses: { amount, category, method }; payouts: till payouts
// { kind, amount, deductions } (paid in cash); vouchers: { cashIn, owed,
// sent, charges, refunded } (refunds sent by mobile money); opening:
// { cash, bank }; profit: { toDate, beforeYear } (net profit up to the
// moment, and up to the start of its financial year).
function position({ orders, purchases, expenses, payouts, vouchers = [], opening, profit }) {
  const confirmed = orders.filter((o) => o.confirmed);
  const cashSales = sum(
    confirmed.filter((o) => inCash(o.method) && o.method !== 'voucher'),
    paidOf,
  );
  const bankSales = sum(
    confirmed.filter((o) => !inCash(o.method) && o.method !== 'voucher'),
    paidOf,
  );
  const payments = purchases.flatMap((p) => p.payments || []);
  const outBy = (rows, pick, cash) =>
    sum(
      rows.filter((r) => inCash(r.method) === cash),
      pick,
    );
  const tills =
    round(opening.cash) +
    cashSales -
    outBy(payments, (p) => p.amount, true) -
    outBy(expenses, (e) => e.amount, true) -
    sum(payouts, (p) => p.amount);
  const bank =
    round(opening.bank) +
    bankSales +
    sum(vouchers, (v) => v.cashIn) -
    sum(
      vouchers.filter((v) => v.refunded),
      (v) => round(v.sent) + round(v.charges),
    ) -
    outBy(payments, (p) => p.amount, false) -
    outBy(expenses, (e) => e.amount, false);
  const receivable = sum(
    orders.filter((o) => !o.confirmed),
    paidOf,
  );
  const equipment = sum(expenses.filter(isAsset), (e) => e.amount);
  const suppliers = sum(purchases, (p) => Math.max(0, round(p.total) - round(p.paid)));
  // Rider pay earned less what was paid out (a shortage taken off a payout
  // counts as settled).
  const riders = Math.max(
    0,
    sum(orders, (o) => o.commission) -
      sum(
        payouts.filter((p) => p.kind === 'rider'),
        (p) => round(p.amount) + round(p.deductions),
      ),
  );
  const refunds = sum(vouchers, (v) => v.owed);
  const cash = tills + bank;
  const current = cash + receivable;
  const assets = current + equipment;
  const liabilities = suppliers + riders + refunds;
  const equity = assets - liabilities;
  const openingTotal = round(opening.cash) + round(opening.bank);
  const toDate = round(profit.toDate);
  const beforeYear = round(profit.beforeYear);
  return {
    assets: {
      tills,
      bank,
      cash,
      receivable,
      current,
      equipment,
      fixed: equipment,
      total: assets,
    },
    liabilities: {
      suppliers,
      riders,
      refunds,
      current: liabilities,
      total: liabilities,
    },
    equity: {
      opening: openingTotal,
      retained: beforeYear,
      currentYear: toDate - beforeYear,
      profit: toDate,
      // Cash over / short: till and cash differences, shortages taken off
      // rider pay; what makes the books balance beyond the recorded profit.
      other: equity - openingTotal - toDate,
      total: equity,
    },
  };
}

// The cash flow statement (indirect method) between two positions, with the
// period's net profit: net income adjusted for what changed in what is owed
// to and by the restaurant gives the cash from operating activities;
// equipment bought is investing. Beginning + net change = ending cash.
function cashFlowStatement({ start, end, netProfit }) {
  const change = (pick) => pick(end) - pick(start);
  const operatingLines = [
    { key: 'receivable', amount: -change((p) => p.assets.receivable) },
    { key: 'payable', amount: change((p) => p.liabilities.suppliers) },
    { key: 'riders', amount: change((p) => p.liabilities.riders) },
    { key: 'vouchers', amount: change((p) => p.liabilities.refunds) },
    { key: 'cash_over_short', amount: change((p) => p.equity.other) },
  ];
  const operating = round(netProfit) + sum(operatingLines, (l) => l.amount);
  const investingLines = [{ key: 'equipment', amount: -change((p) => p.assets.equipment) }];
  const investing = sum(investingLines, (l) => l.amount);
  // Money the owner puts in or takes out (opening balances changed).
  const financingLines = [{ key: 'owner', amount: change((p) => p.equity.opening) }];
  const financing = sum(financingLines, (l) => l.amount);
  return {
    beginning: start.assets.cash,
    operating: { netIncome: round(netProfit), lines: operatingLines, total: operating },
    investing: { lines: investingLines, total: investing },
    financing: { lines: financingLines, total: financing },
    netChange: operating + investing + financing,
    ending: end.assets.cash,
  };
}

// Business performance ratios for a period from its profit and loss and the
// position at its end (null when the base is 0).
function ratios({ pl, position: pos, receivableBefore = 0 }) {
  const div = (a, b) => (b ? Math.round((a / b) * 100) / 100 : null);
  const sales = pl.revenue.total;
  const averageReceivable = (round(receivableBefore) + pos.assets.receivable) / 2;
  return {
    grossProfit: div(pl.grossProfit, sales),
    netProfit: div(pl.netProfit, sales),
    operatingCost: div(pl.operating.total, sales),
    current: div(pos.assets.current, pos.liabilities.current),
    acidTest: div(pos.assets.current, pos.liabilities.current),
    debt: div(pos.liabilities.total, pos.assets.total),
    debtToEquity: div(pos.liabilities.total, pos.equity.total),
    receivableTurnover: div(sales, averageReceivable),
  };
}

module.exports = { profitAndLoss, position, cashFlowStatement, ratios, paidOf, isAsset };
