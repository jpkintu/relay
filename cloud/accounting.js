// Accounting statements (Admin → Accounting) for the owner and finance:
// profit and loss, balance sheet and cash flow, for the whole restaurant or
// one branch. The maths and the rules are in lib/accounts.js.

const { MASTER, invalid, audit, loadConfig, findAll } = require('./lib/core');
const { resolveRange, previousRange, isDay, isoDay, startOfDay, addDays } = require('./lib/dates');
const { isConfirmed } = require('./lib/reports');
const A = require('./lib/accounts');
const { factOf } = require('./reports');
const { branchParam } = require('./branches');
const { requireFinance } = require('./spending');

const inBranch = (query, branch) => (branch ? query.equalTo('branch', branch) : query);

// Delivered orders (as facts with `confirmed`) delivered in [start, end).
async function deliveredIn(start, end, branch) {
  const query = inBranch(new Parse.Query('Order'), branch);
  query.equalTo('status', 'DELIVERED');
  if (start) query.greaterThanOrEqualTo('deliveredAt', start);
  query.lessThan('deliveredAt', end);
  return (await findAll(query)).map((order) => {
    const fact = factOf(order);
    return { ...fact, confirmed: isConfirmed(fact) };
  });
}

// Purchases and expenses (not voided) dated in [start, end).
async function spentIn(className, start, end, branch) {
  const query = inBranch(new Parse.Query(className), branch);
  query.doesNotExist('voidedAt');
  if (start) query.greaterThanOrEqualTo('spentAt', start);
  query.lessThan('spentAt', end);
  return findAll(query);
}

// Vouchers (vouchers.js): money paid for cancelled orders, owed to the
// customer until spent on a new order or refunded. Each with:
// - cashIn: money that came in with it (none for what is left of a spent
//   voucher, or a voucher given back from a cancelled order);
// - when it stops being owed: refunded, or the order it paid was delivered
//   (until then it is the customer's money paid in advance); a voucher spent
//   on an order that was then cancelled is given back as a new one.
async function voucherRows(end, branch) {
  const vouchers = require('./vouchers');
  await vouchers.backfill();
  const query = inBranch(new Parse.Query(vouchers.CLASS), branch);
  query.include('usedOrder');
  const rows = await findAll(query);
  return rows
    .map((row) => {
      const used = row.get('usedOrder');
      const usedEnd =
        row.get('status') === 'used'
          ? used?.get('status') === 'DELIVERED'
            ? used.get('deliveredAt')
            : used?.get('status') === 'CANCELLED'
              ? used.get('cancelledAt') || used.updatedAt
              : null
          : null;
      return {
        id: row.id,
        code: row.get('code'),
        kind: row.get('kind') || 'payment',
        status: row.get('status'),
        amount: Math.round(Number(row.get('amount') || 0)),
        usedAmount: Math.round(Number(row.get('usedAmount') || 0)),
        cashIn: Math.round(Number(row.get('cashIn') ?? row.get('amount') ?? 0)),
        openedAt: row.get('openedAt') || row.createdAt,
        usedAt: row.get('usedAt') || null,
        closedAt: row.get('refundedAt') || usedEnd || null,
        refundedAt: row.get('refundedAt') || null,
        sent: Math.round(Number(row.get('refundSent') || 0)),
        charges: Math.round(Number(row.get('refundCharges') || 0)),
        note: row.get('refundNote') || '',
        orderId: row.get('sourceOrder')?.id || used?.id || '',
        orderCode: row.get('sourceCode') || row.get('usedCode') || '',
        usedCode: row.get('usedCode') || '',
        phone: row.get('phone') || '',
      };
    })
    .filter((row) => row.openedAt < end);
}
// What a voucher owed the customer at `end`: all of it until spent; once
// spent, what it paid until that order is delivered (the rest is a new
// voucher); nothing once refunded or delivered.
function owedAt(row, end) {
  if (row.closedAt && row.closedAt < end) return 0;
  if (row.usedAt && row.usedAt < end) return row.usedAmount;
  return row.amount;
}
const refundView = (row, end) => ({
  id: row.id,
  code: row.code,
  kind: row.kind,
  amount: row.amount,
  owed: owedAt(row, end),
  status: row.refundedAt && row.refundedAt < end ? 'refunded' : row.status,
  orderId: row.orderId,
  orderCode: row.orderCode,
  usedCode: row.usedCode,
  phone: row.phone,
  receivedAt: row.openedAt.toISOString(),
  refundedAt: row.refundedAt && row.refundedAt < end ? row.refundedAt.toISOString() : null,
  usedAt: row.usedAt && row.usedAt < end ? row.usedAt.toISOString() : null,
  sent: row.sent,
  charges: row.charges,
  note: row.note,
});
const inWindow = (date, start, end) => !!date && date < end && (!start || date >= start);
// Money in for vouchers, and refunds sent (with the charges for sending).
const voucherCash = (rows, start, end) => ({
  refundReceipts: rows
    .filter((r) => r.cashIn > 0 && inWindow(r.openedAt, start, end))
    .map((r) => ({ amount: r.cashIn })),
  refundsPaid: rows
    .filter((r) => inWindow(r.refundedAt, start, end))
    .map((r) => ({ amount: r.sent, charges: r.charges })),
});

async function payoutsIn(start, end, branch) {
  const query = inBranch(new Parse.Query('TillPayout'), branch);
  if (start) query.greaterThanOrEqualTo('paidAt', start);
  query.lessThan('paidAt', end);
  return (await findAll(query)).map((row) => ({
    kind: row.get('kind'),
    amount: Number(row.get('amount') || 0),
    deductions: Number(row.get('deductions') || 0),
  }));
}

// Supplier payments made on days in [fromDay, toDay] (inclusive), from the
// purchases dated up to `end`.
function supplierPayments(purchases, fromDay, toDay) {
  const out = [];
  for (const row of purchases)
    for (const payment of row.get('payments') || [])
      if ((!fromDay || payment.day >= fromDay) && payment.day <= toDay)
        out.push({ amount: Number(payment.amount || 0) });
  return out;
}

const purchaseFacts = (rows) =>
  rows.map((row) => ({
    total: Number(row.get('total') || 0),
    paid: Number(row.get('paid') || 0),
    category: row.get('category') || 'other',
  }));
const expenseFacts = (rows) =>
  rows.map((row) => ({ amount: Number(row.get('amount') || 0), category: row.get('category') }));

async function profitAndLoss(start, end, branch) {
  const [orders, purchases, expenses, payouts] = await Promise.all([
    deliveredIn(start, end, branch),
    spentIn('Purchase', start, end, branch),
    spentIn('Expense', start, end, branch),
    payoutsIn(start, end, branch),
  ]);
  return A.profitAndLoss({
    orders,
    purchases: purchaseFacts(purchases),
    expenses: expenseFacts(expenses),
    tillExpenses: payouts.filter((p) => p.kind !== 'rider'),
  });
}

// The owner's opening cash and bank, counted for the whole restaurant only.
const openingOf = (config, branch) => (branch ? 0 : Math.round(Number(config.openingBalance) || 0));

// Cash and bank at the end of `toDay` (restaurant time).
async function cashAt(toDay, config, branch) {
  const end = startOfDay(addDays(toDay, 1), config.timezone);
  const [orders, purchases, expenses, payouts, refunds] = await Promise.all([
    deliveredIn(null, end, branch),
    spentIn('Purchase', null, end, branch),
    spentIn('Expense', null, end, branch),
    payoutsIn(null, end, branch),
    voucherRows(end, branch),
  ]);
  const movements = A.cashMovements({
    orders,
    supplierPayments: supplierPayments(purchases, null, toDay),
    expenses: expenseFacts(expenses),
    payouts,
    ...voucherCash(refunds, null, end),
  });
  return {
    cash: openingOf(config, branch) + movements.net,
    orders,
    purchases,
    expenses,
    payouts,
    refunds,
    end,
  };
}

function rangeOf(params, config) {
  const range = resolveRange(params, config.timezone, { defaultDays: 30 });
  if (range.error) throw invalid(range.error);
  return range;
}

// { from, to, branchId? } → this period and the one before, for comparison.
Parse.Cloud.define('getProfitAndLoss', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const range = rangeOf(request.params, config);
  const before = previousRange(range, config.timezone);
  const branch = await branchParam(request.params.branchId);
  const [current, previous] = await Promise.all([
    profitAndLoss(range.start, range.end, branch),
    profitAndLoss(before.start, before.end, branch),
  ]);
  return {
    range: { from: range.from, to: range.to },
    previousRange: { from: before.from, to: before.to },
    current,
    previous,
  };
});

// { day?, branchId? } → the balance sheet at the end of that day (today by
// default).
Parse.Cloud.define('getBalanceSheet', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const today = isoDay(new Date(), config.timezone);
  const day = request.params.day || today;
  if (!isDay(day) || day > today) throw invalid('Choose a day up to today');
  const branch = await branchParam(request.params.branchId);
  const at = await cashAt(day, config, branch);
  const profit = A.profitAndLoss({
    orders: at.orders,
    purchases: purchaseFacts(at.purchases),
    expenses: expenseFacts(at.expenses),
    tillExpenses: at.payouts.filter((p) => p.kind !== 'rider'),
  }).netProfit;
  // What was still unpaid on each purchase at that day.
  const purchases = at.purchases.map((row) => ({
    total: Number(row.get('total') || 0),
    paid: (row.get('payments') || [])
      .filter((payment) => payment.day <= day)
      .reduce((n, payment) => n + Number(payment.amount || 0), 0),
  }));
  // Vouchers still owed at that day (a liability), and those cleared
  // (refunded, or spent on an order delivered) in the 90 days before it.
  const owed = at.refunds.filter((row) => owedAt(row, at.end) > 0);
  const cleared = at.refunds
    .filter(
      (row) =>
        owedAt(row, at.end) === 0 &&
        (row.closedAt || row.usedAt) &&
        at.end - (row.closedAt || row.usedAt) < 90 * 86400000,
    )
    .sort((a, b) => (b.closedAt || b.usedAt) - (a.closedAt || a.usedAt));
  return {
    day,
    openingBalance: openingOf(config, branch),
    openingSet: config.openingBalance !== undefined && config.openingBalance !== null,
    sheet: A.balanceSheet({
      openingBalance: openingOf(config, branch),
      cash: at.cash,
      orders: at.orders,
      purchases,
      payouts: at.payouts,
      profit,
      refundsOwed: owed.reduce((n, row) => n + owedAt(row, at.end), 0),
    }),
    refunds: {
      owed: owed.map((row) => refundView(row, at.end)),
      cleared: cleared.map((row) => refundView(row, at.end)),
    },
  };
});

// { from, to, branchId? } → opening cash, money in and out, closing cash.
Parse.Cloud.define('getCashFlow', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const range = rangeOf(request.params, config);
  const branch = await branchParam(request.params.branchId);
  const [opening, orders, purchases, expenses, payouts, refunds] = await Promise.all([
    cashAt(addDays(range.from, -1), config, branch).then((at) => at.cash),
    deliveredIn(range.start, range.end, branch),
    spentIn('Purchase', null, range.end, branch),
    spentIn('Expense', range.start, range.end, branch),
    payoutsIn(range.start, range.end, branch),
    voucherRows(range.end, branch),
  ]);
  const movements = A.cashMovements({
    orders,
    supplierPayments: supplierPayments(purchases, range.from, range.to),
    expenses: expenseFacts(expenses),
    payouts,
    ...voucherCash(refunds, range.start, range.end),
  });
  return {
    range: { from: range.from, to: range.to },
    ...A.cashFlow({ opening, movements }),
  };
});

// Owner / finance: the cash and bank the restaurant had when it started
// keeping its books in Relay (the balance sheet's opening balance).
Parse.Cloud.define('saveOpeningBalance', async (request) => {
  const { user: actor } = await requireFinance(request);
  const amount = Math.round(Number(request.params.amount));
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000000000)
    throw invalid('Enter the opening cash and bank balance');
  const { object: config } = await loadConfig();
  if (!config) throw invalid('Save the restaurant settings first');
  const before = { openingBalance: config.get('openingBalance') ?? null };
  config.set('openingBalance', amount);
  await config.save(null, MASTER);
  await audit(actor, 'accounting.opening_balance', config, before, { openingBalance: amount });
  return { openingBalance: amount };
});
