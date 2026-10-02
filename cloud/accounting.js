// Accounting statements (Admin → Accounting) for the owner and finance, in
// the standard form: profit and loss, balance sheet and cash flow statement
// (each with a column to compare), and business performance ratios, for the
// whole restaurant or one branch. The maths and the rules are in
// lib/accounts.js.

const { MASTER, invalid, forbidden, audit, loadConfig, findAll } = require('./lib/core');
const { resolveRange, previousRange, isDay, isoDay, startOfDay, addDays } = require('./lib/dates');
const { isConfirmed } = require('./lib/reports');
const A = require('./lib/accounts');
const { stockValueAt } = require('./lib/stock');
const { factOf } = require('./reports');
const { branchParam } = require('./branches');
const { requireFinance } = require('./spending');

const inBranch = (query, branch) => (branch ? query.equalTo('branch', branch) : query);
const num = (value) => Math.round(Number(value) || 0);

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
// Everything recorded before `end` (one load; the statements filter it).
async function load(end, branch) {
  const orderQuery = inBranch(new Parse.Query('Order'), branch);
  orderQuery.equalTo('status', 'DELIVERED');
  orderQuery.lessThan('deliveredAt', end);
  const spent = (className) => {
    const query = inBranch(new Parse.Query(className), branch);
    query.doesNotExist('voidedAt');
    query.lessThan('spentAt', end);
    return findAll(query);
  };
  const payoutQuery = inBranch(new Parse.Query('TillPayout'), branch);
  payoutQuery.lessThan('paidAt', end);
  const [orders, purchases, expenses, payouts, vouchers, counts] = await Promise.all([
    findAll(orderQuery),
    spent('Purchase'),
    spent('Expense'),
    findAll(payoutQuery),
    voucherRows(end, branch),
    require('./stock').countsFor(branch, end),
  ]);
  return {
    orders: orders.map((order) => {
      const fact = factOf(order);
      return { ...fact, at: order.get('deliveredAt'), confirmed: isConfirmed(fact) };
    }),
    purchases: purchases.map((row) => ({
      at: row.get('spentAt'),
      total: num(row.get('total')),
      category: row.get('category') || 'other',
      payments: (row.get('payments') || []).map((p) => ({
        day: p.day,
        amount: num(p.amount),
        method: p.method || 'cash',
      })),
    })),
    expenses: expenses.map((row) => ({
      at: row.get('spentAt'),
      amount: num(row.get('amount')),
      category: row.get('category'),
      method: row.get('method') || 'cash',
    })),
    payouts: payouts.map((row) => ({
      at: row.get('paidAt'),
      kind: row.get('kind'),
      amount: num(row.get('amount')),
      deductions: num(row.get('deductions')),
    })),
    vouchers,
    // Stock counts (stock.js): the stock on hand at any moment.
    counts,
  };
}

const within = (rows, start, end) => rows.filter((r) => r.at < end && (!start || r.at >= start));

// Stock on hand at a moment (nothing before the first count).
const stockAt = (rec, at) => (at ? stockValueAt(rec.counts, at) : 0);

// Profit and loss for [start, end).
function plOf(rec, start, end) {
  const payouts = within(rec.payouts, start, end);
  return A.profitAndLoss({
    orders: within(rec.orders, start, end),
    purchases: within(rec.purchases, start, end),
    expenses: within(rec.expenses, start, end),
    tillExpenses: payouts.filter((p) => p.kind !== 'rider'),
    stockStart: stockAt(rec, start),
    stockEnd: stockAt(rec, end),
  });
}

// The first day of the financial year `day` falls in (fiscalYearStart: its
// first month, 1 = January).
function yearStartOf(day, config) {
  const month = Math.min(12, Math.max(1, Number(config.fiscalYearStart) || 1));
  const year = Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < month ? 1 : 0);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

// The owner's opening cash and mobile money / bank (whole restaurant only).
// A single figure saved before they were split counts as cash.
function openingOf(config, branch) {
  if (branch) return { cash: 0, bank: 0 };
  const split = config.openingCash !== undefined && config.openingCash !== null;
  return {
    cash: num(split ? config.openingCash : config.openingBalance),
    bank: split ? num(config.openingBank) : 0,
  };
}

// The position at the end of `toDay` (restaurant time).
function positionOf(rec, toDay, config, branch) {
  const end = startOfDay(addDays(toDay, 1), config.timezone);
  const yearStart = startOfDay(yearStartOf(toDay, config), config.timezone);
  return A.position({
    orders: within(rec.orders, null, end),
    purchases: within(rec.purchases, null, end).map((p) => {
      const payments = p.payments.filter((pay) => pay.day <= toDay);
      return { ...p, payments, paid: payments.reduce((n, pay) => n + pay.amount, 0) };
    }),
    expenses: within(rec.expenses, null, end),
    payouts: within(rec.payouts, null, end),
    vouchers: rec.vouchers.map((v) => ({
      cashIn: v.openedAt < end ? v.cashIn : 0,
      owed: v.openedAt < end ? owedAt(v, end) : 0,
      refunded: !!v.refundedAt && v.refundedAt < end,
      sent: v.sent,
      charges: v.charges,
    })),
    opening: openingOf(config, branch),
    inventory: stockAt(rec, end),
    profit: {
      toDate: plOf(rec, null, end).netProfit,
      beforeYear: plOf(rec, null, yearStart).netProfit,
    },
  });
}

// The period to compare with, as statements do: a period starting on its
// financial year's first day is compared with the whole previous financial
// year; one starting on a month's first day with as many whole months
// before it; any other with the same number of days before it.
function comparisonRange(range, config) {
  const monthShift = (day, months) => {
    const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + months);
    return date.toISOString().slice(0, 10);
  };
  let from = null;
  if (range.from === yearStartOf(range.from, config)) from = monthShift(range.from, -12);
  else if (range.from.endsWith('-01')) {
    const months =
      (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
      Number(range.to.slice(5, 7)) -
      Number(range.from.slice(5, 7)) +
      1;
    from = monthShift(range.from, -months);
  }
  if (!from) return previousRange(range, config.timezone);
  const compared = resolveRange({ from, to: addDays(range.from, -1) }, config.timezone, {
    maxDays: 3660,
  });
  if (compared.error) throw invalid(compared.error);
  return compared;
}

function rangeOf(params, config) {
  // Statements cover up to ten years (a financial year, or several).
  const range = resolveRange(params, config.timezone, { defaultDays: 30, maxDays: 3660 });
  if (range.error) throw invalid(range.error);
  return range;
}

// { from, to, branchId? } → this period and the one before, to compare.
Parse.Cloud.define('getProfitAndLoss', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const range = rangeOf(request.params, config);
  const before = comparisonRange(range, config);
  const branch = await branchParam(request.params.branchId);
  const rec = await load(range.end, branch);
  return {
    basis: 'accrual',
    range: { from: range.from, to: range.to },
    previousRange: { from: before.from, to: before.to },
    current: plOf(rec, range.start, range.end),
    previous: plOf(rec, before.start, before.end),
  };
});

// { day?, compareDay?, branchId? } → the balance sheet at the end of that day
// (today by default), and at the compare day (a year earlier by default).
Parse.Cloud.define('getBalanceSheet', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const today = isoDay(new Date(), config.timezone);
  const day = request.params.day || today;
  if (!isDay(day) || day > today) throw invalid('Choose a day up to today');
  const compareDay = request.params.compareDay || `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
  if (!isDay(compareDay) || compareDay > today) throw invalid('Choose a day up to today');
  const branch = await branchParam(request.params.branchId);
  const end = startOfDay(addDays(day > compareDay ? day : compareDay, 1), config.timezone);
  const rec = await load(end, branch);
  const at = startOfDay(addDays(day, 1), config.timezone);
  // Vouchers still owed at that day, and those cleared (refunded, or spent
  // on an order delivered) in the 90 days before it.
  const vouchers = rec.vouchers.filter((row) => row.openedAt < at);
  const owed = vouchers.filter((row) => owedAt(row, at) > 0);
  const cleared = vouchers
    .filter(
      (row) =>
        owedAt(row, at) === 0 &&
        (row.closedAt || row.usedAt) &&
        at - (row.closedAt || row.usedAt) < 90 * 86400000,
    )
    .sort((a, b) => (b.closedAt || b.usedAt) - (a.closedAt || a.usedAt));
  const opening = openingOf(config, branch);
  return {
    basis: 'accrual',
    day,
    compareDay,
    fiscalYearStart: Number(config.fiscalYearStart) || 1,
    yearStart: yearStartOf(day, config),
    openingBalance: opening.cash + opening.bank,
    opening,
    openingSet:
      (config.openingBalance !== undefined && config.openingBalance !== null) ||
      (config.openingCash !== undefined && config.openingCash !== null),
    sheet: positionOf(rec, day, config, branch),
    compare: positionOf(rec, compareDay, config, branch),
    refunds: {
      owed: owed.map((row) => refundView(row, at)),
      cleared: cleared.map((row) => refundView(row, at)),
    },
  };
});

// The cash flow statement for [range]: from the position the day before it
// to the position at its end.
function flowOf(rec, range, config, branch) {
  return A.cashFlowStatement({
    start: positionOf(rec, addDays(range.from, -1), config, branch),
    end: positionOf(rec, range.to, config, branch),
    netProfit: plOf(rec, range.start, range.end).netProfit,
  });
}

// { from, to, branchId? } → this period and the one before.
Parse.Cloud.define('getCashFlow', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const range = rangeOf(request.params, config);
  const before = comparisonRange(range, config);
  const branch = await branchParam(request.params.branchId);
  const rec = await load(range.end, branch);
  return {
    range: { from: range.from, to: range.to },
    previousRange: { from: before.from, to: before.to },
    current: flowOf(rec, range, config, branch),
    previous: flowOf(rec, before, config, branch),
  };
});

// { to?, months?, branchId? } → business performance ratios, month by month
// (12 months to the month of `to` by default), with what they are made of.
Parse.Cloud.define('getPerformanceRatios', async (request) => {
  await requireFinance(request);
  const { values: config } = await loadConfig();
  const today = isoDay(new Date(), config.timezone);
  const to = request.params.to || today;
  if (!isDay(to) || to > today) throw invalid('Choose a month up to this one');
  const count = Math.min(24, Math.max(1, Math.round(Number(request.params.months) || 12)));
  const branch = await branchParam(request.params.branchId);
  const monthStart = (day, back) => {
    const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - back);
    return date.toISOString().slice(0, 10);
  };
  const months = Array.from({ length: count + 1 }, (_, i) => monthStart(to, count - i));
  const lastDay = (first) => {
    const next = monthStart(first, -1);
    const day = addDays(next, -1);
    return day > today ? today : day;
  };
  const end = startOfDay(addDays(lastDay(months.at(-1)), 1), config.timezone);
  const rec = await load(end, branch);
  const positions = months.map((first) => positionOf(rec, lastDay(first), config, branch));
  return {
    months: months.slice(1).map((first, i) => {
      const pl = plOf(
        rec,
        startOfDay(first, config.timezone),
        startOfDay(addDays(lastDay(first), 1), config.timezone),
      );
      const pos = positions[i + 1];
      return {
        month: first.slice(0, 7),
        sales: pl.revenue.total,
        grossProfit: pl.grossProfit,
        netProfit: pl.netProfit,
        operatingCost: pl.operating.total,
        currentAssets: pos.assets.current,
        currentLiabilities: pos.liabilities.current,
        totalAssets: pos.assets.total,
        totalLiabilities: pos.liabilities.total,
        equity: pos.equity.total,
        receivable: pos.assets.receivable,
        inventory: pos.assets.inventory,
        ratios: A.ratios({
          pl,
          position: pos,
          receivableBefore: positions[i].assets.receivable,
        }),
      };
    }),
  };
});

// Owner / finance: the cash and the mobile money / bank the restaurant had
// when it started keeping its books in RelayEats (the opening balances), and
// the month its financial year starts. { cash, bank, fiscalYearStart } or
// { amount } (one figure: cash).
Parse.Cloud.define('saveOpeningBalance', async (request) => {
  const { user: actor, branch } = await requireFinance(request);
  // The opening balances are the whole restaurant's.
  if (branch) throw forbidden('Only the owner or finance for all branches can set these');
  const p = request.params || {};
  const money = (value, label) => {
    const amount = Math.round(Number(value ?? 0));
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000000)
      throw invalid(`Enter the opening ${label}`);
    return amount;
  };
  const cash = money(p.cash ?? p.amount, 'cash and bank balance');
  const bank = money(p.bank, 'mobile money and bank balance');
  const { object: config, values } = await loadConfig();
  if (!config) throw invalid('Save the restaurant settings first');
  const fiscalYearStart =
    p.fiscalYearStart === undefined
      ? Number(values.fiscalYearStart) || 1
      : Number(p.fiscalYearStart);
  if (!Number.isInteger(fiscalYearStart) || fiscalYearStart < 1 || fiscalYearStart > 12)
    throw invalid('Choose the month the financial year starts');
  const before = {
    openingBalance: config.get('openingBalance') ?? null,
    openingCash: config.get('openingCash') ?? null,
    openingBank: config.get('openingBank') ?? null,
    fiscalYearStart: config.get('fiscalYearStart') ?? null,
  };
  const next = {
    openingBalance: cash + bank,
    openingCash: cash,
    openingBank: bank,
    fiscalYearStart,
  };
  config.set(next);
  await config.save(null, MASTER);
  await audit(actor, 'accounting.opening_balance', config, before, next);
  return next;
});
