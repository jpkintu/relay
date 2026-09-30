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
  const [orders, purchases, expenses, payouts] = await Promise.all([
    deliveredIn(null, end, branch),
    spentIn('Purchase', null, end, branch),
    spentIn('Expense', null, end, branch),
    payoutsIn(null, end, branch),
  ]);
  const movements = A.cashMovements({
    orders,
    supplierPayments: supplierPayments(purchases, null, toDay),
    expenses: expenseFacts(expenses),
    payouts,
  });
  return { cash: openingOf(config, branch) + movements.net, orders, purchases, expenses, payouts };
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
    }),
  };
});

// { from, to, branchId? } → opening cash, money in and out, closing cash.
Parse.Cloud.define('getCashFlow', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const range = rangeOf(request.params, config);
  const branch = await branchParam(request.params.branchId);
  const [opening, orders, purchases, expenses, payouts] = await Promise.all([
    cashAt(addDays(range.from, -1), config, branch).then((at) => at.cash),
    deliveredIn(range.start, range.end, branch),
    spentIn('Purchase', null, range.end, branch),
    spentIn('Expense', range.start, range.end, branch),
    payoutsIn(range.start, range.end, branch),
  ]);
  const movements = A.cashMovements({
    orders,
    supplierPayments: supplierPayments(purchases, range.from, range.to),
    expenses: expenseFacts(expenses),
    payouts,
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
