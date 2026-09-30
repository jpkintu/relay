// The accounting statements (Admin → Accounting), as pure functions of plain
// records so the maths can be unit-tested. accounting.js loads the records.
//
// Relay keeps no general ledger; the statements are worked out from what the
// app records, on these rules:
// - Revenue is earned when an order is delivered or served (its total: food
//   plus the delivery fee).
// - Stock bought is a cost of sales when it is bought (no stock counts).
// - Rider pay (commission plus the delivery fees passed on) is an operating
//   cost when the order is delivered; it is owed until paid out.
// - Cash and bank are worked out: the opening balance the owner enters, plus
//   money received for sales (cash counted in, mobile money and card
//   verified), less supplier payments, expenses and payouts from the tills.
// - Money not yet received for delivered sales (cash still with riders,
//   payments waiting for a check, bills still open) is owed to the
//   restaurant; unpaid purchases and unpaid rider pay are what it owes.

const round = (value) => Math.round(Number(value) || 0);
const sum = (rows, pick) => rows.reduce((n, row) => n + round(pick(row)), 0);

function byKey(rows, key, amount) {
  const out = {};
  for (const row of rows) out[row[key]] = (out[row[key]] || 0) + round(amount(row));
  return Object.entries(out)
    .map(([k, value]) => ({ key: k, amount: value }))
    .sort((a, b) => b.amount - a.amount);
}

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
  const expenseRows = byKey(expenses, 'category', (e) => e.amount);
  const fromTills = sum(tillExpenses, (e) => e.amount);
  const operating = riderPay + sum(expenses, (e) => e.amount) + fromTills;
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

// Money in and out up to a moment. orders: delivered order facts with
// `confirmed` (money in hand); supplierPayments: { amount }; expenses:
// { amount }; payouts: till payouts { amount } (rider pay and till
// expenses).
function cashMovements({ orders, supplierPayments, expenses, payouts }) {
  const received = sum(
    orders.filter((o) => o.confirmed),
    (o) => o.total,
  );
  const toSuppliers = sum(supplierPayments, (p) => p.amount);
  const onExpenses = sum(expenses, (e) => e.amount);
  const riderPay = sum(
    payouts.filter((p) => p.kind === 'rider'),
    (p) => p.amount,
  );
  const fromTills = sum(
    payouts.filter((p) => p.kind !== 'rider'),
    (p) => p.amount,
  );
  return {
    received,
    toSuppliers,
    onExpenses,
    riderPay,
    fromTills,
    net: received - toSuppliers - onExpenses - riderPay - fromTills,
  };
}

// The cash flow for a period: opening cash, what came in and went out, and
// closing cash (= opening + net).
function cashFlow({ opening, movements }) {
  return {
    opening,
    inflows: [{ key: 'sales', amount: movements.received }],
    outflows: [
      { key: 'suppliers', amount: movements.toSuppliers },
      { key: 'expenses', amount: movements.onExpenses },
      { key: 'rider_pay', amount: movements.riderPay },
      { key: 'till_expenses', amount: movements.fromTills },
    ],
    net: movements.net,
    closing: opening + movements.net,
  };
}

// The balance sheet at a moment, from everything up to it.
// orders: delivered order facts with `confirmed`; purchases: { total, paid };
// payouts: till payouts { kind, amount, deductions }; profit: net profit to
// date (profitAndLoss over the same records); openingBalance: the owner's
// starting cash and bank.
function balanceSheet({ openingBalance, cash, orders, purchases, payouts, profit }) {
  const receivable = sum(
    orders.filter((o) => !o.confirmed),
    (o) => o.total,
  );
  const owedToSuppliers = sum(purchases, (p) => Math.max(0, round(p.total) - round(p.paid)));
  // Rider pay earned less what was paid out (a shortage taken off a payout
  // counts as settled).
  const riderPayEarned = sum(orders, (o) => o.commission);
  const riderPaySettled = sum(
    payouts.filter((p) => p.kind === 'rider'),
    (p) => round(p.amount) + round(p.deductions),
  );
  const owedToRiders = Math.max(0, riderPayEarned - riderPaySettled);
  const assets = cash + receivable;
  const liabilities = owedToSuppliers + owedToRiders;
  const equity = assets - liabilities;
  return {
    assets: { cash, receivable, total: assets },
    liabilities: { suppliers: owedToSuppliers, riders: owedToRiders, total: liabilities },
    equity: {
      opening: openingBalance,
      profit,
      // Cash shortages, till differences and the like: what makes the books
      // balance beyond the recorded profit.
      other: equity - openingBalance - profit,
      total: equity,
    },
  };
}

module.exports = { profitAndLoss, cashMovements, cashFlow, balanceSheet };
