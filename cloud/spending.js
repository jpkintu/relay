// Purchases and expenses (Admin → Purchases & expenses), for the owner and
// the finance role.
//
// - Suppliers: who the restaurant buys from.
// - Purchases: stock bought from a supplier (food, drinks, packaging…), paid
//   now, in part or later ("on credit"); later payments are recorded against
//   the purchase, so what is owed to each supplier is always the purchases
//   less what was paid.
// - Expenses: running costs (rent, salaries, utilities…).
//
// Nothing is deleted: a mistake is voided with a reason and stays in the
// audit log. Amounts are whole units of the restaurant's currency; each
// record carries the calendar day it happened (`day`, restaurant time) and
// its branch. The accounting statements (accounting.js) read these.

const {
  MASTER,
  invalid,
  requireRole,
  audit,
  loadConfig,
  findAll,
  readAcl,
  nextDailyCode,
} = require('./lib/core');
const { isDay, isoDay, startOfDay, resolveRange } = require('./lib/dates');
const { branchParam, branchFor } = require('./branches');

const ROLES = ['admin', 'finance'];
const ACL_ROLES = ['admin', 'finance'];
const METHODS = ['cash', 'mobile_money', 'bank', 'card', 'cheque'];
const PURCHASE_CATEGORIES = ['food', 'drinks', 'packaging', 'cleaning', 'gas_fuel', 'other'];
const EXPENSE_CATEGORIES = [
  'rent',
  'salaries',
  'utilities',
  'transport',
  'marketing',
  'repairs',
  'equipment',
  'licences_taxes',
  'bank_charges',
  'other',
];
const MAX = 1000000000;

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const ID = /^[A-Za-z0-9]{1,32}$/;

// Owner and finance, on a restaurant that has the accounting part of the app
// (every restaurant here; Relay Hosted's plans may leave it out).
async function requireFinance(request) {
  const who = await requireRole(request, ROLES);
  const features = await require('./lib/limits').features();
  if (features.accounting === false)
    throw invalid('Purchases, expenses and accounting are not part of your plan');
  return who;
}

function amountOf(value, label, { allowZero = false } = {}) {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX || (!allowZero && amount === 0))
    throw invalid(`Enter the ${label}`);
  return amount;
}

function methodOf(value) {
  const method = String(value || 'cash');
  if (!METHODS.includes(method)) throw invalid('Choose how it was paid');
  return method;
}

// The calendar day it happened: today by default, never in the future.
function dayOf(value, config) {
  const today = isoDay(new Date(), config.timezone);
  const day = value ? String(value) : today;
  if (!isDay(day) || day > today) throw invalid('Choose a day up to today');
  return day;
}
// Noon of that day, so it sorts and filters by date whatever the timezone.
const instantOf = (day, config) =>
  new Date(startOfDay(day, config.timezone).getTime() + 12 * 3600000);

function rangeOf(params, config) {
  const range = resolveRange(params, config.timezone, { defaultDays: 30 });
  if (range.error) throw invalid(range.error);
  return range;
}

const nameOf = (user) => (user ? user.get('name') || user.get('username') || '' : '');

// ---------------------------------------------------------------------------
// Suppliers

const supplierView = (row, owed = 0) => ({
  id: row.id,
  name: row.get('name'),
  phone: row.get('phone') || '',
  email: row.get('email') || '',
  address: row.get('address') || '',
  tin: row.get('tin') || '',
  notes: row.get('notes') || '',
  active: row.get('active') !== false,
  owed,
});

// What is still owed on each purchase: its total less what was paid.
const owedOn = (purchase) =>
  purchase.get('voidedAt')
    ? 0
    : Math.max(0, Number(purchase.get('total') || 0) - Number(purchase.get('paid') || 0));

async function owedBySupplier() {
  const query = new Parse.Query('Purchase');
  query.doesNotExist('voidedAt');
  query.notEqualTo('status', 'paid');
  const owed = {};
  for (const row of await findAll(query)) {
    const id = row.get('supplier')?.id;
    if (id) owed[id] = (owed[id] || 0) + owedOn(row);
  }
  return owed;
}

Parse.Cloud.define('listSuppliers', async (request) => {
  await requireFinance(request);
  const [rows, owed] = await Promise.all([findAll(new Parse.Query('Supplier')), owedBySupplier()]);
  return {
    suppliers: rows
      .sort((a, b) => a.get('name').localeCompare(b.get('name')))
      .map((row) => supplierView(row, owed[row.id] || 0)),
  };
});

// { id?, name, phone, email, address, tin, notes, active }
Parse.Cloud.define('saveSupplier', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params;
  const name = clean(p.name, 80);
  if (name.length < 2) throw invalid('Enter the supplier name');
  const all = await findAll(new Parse.Query('Supplier'));
  if (all.some((row) => row.id !== p.id && row.get('name').toLowerCase() === name.toLowerCase()))
    throw invalid(`There is already a supplier called "${name}"`);
  const row = p.id ? all.find((r) => r.id === p.id) : new Parse.Object('Supplier');
  if (!row) throw invalid('Unknown supplier');
  const before = p.id ? supplierView(row) : null;
  row.set({
    name,
    phone: clean(p.phone, 30),
    email: clean(p.email, 120),
    address: clean(p.address, 200),
    tin: clean(p.tin, 20),
    notes: clean(p.notes, 300),
    active: p.active === undefined ? row.get('active') !== false : p.active === true,
  });
  row.setACL(readAcl(null, ACL_ROLES));
  await row.save(null, MASTER);
  await audit(
    actor,
    p.id ? 'supplier.updated' : 'supplier.created',
    row,
    before,
    supplierView(row),
  );
  return supplierView(row);
});

async function supplierParam(id, { required = false } = {}) {
  if (!id) {
    if (required) throw invalid('Choose the supplier');
    return null;
  }
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('Unknown supplier');
  const row = await new Parse.Query('Supplier').get(id, MASTER).catch(() => null);
  if (!row) throw invalid('Unknown supplier');
  return row;
}

// ---------------------------------------------------------------------------
// Purchases

function purchaseView(row) {
  const payments = row.get('payments') || [];
  return {
    id: row.id,
    code: row.get('purchaseCode'),
    day: row.get('day'),
    supplierId: row.get('supplier')?.id || '',
    supplier: row.get('supplier')?.get?.('name') || row.get('supplierName') || '',
    branchId: row.get('branch')?.id || '',
    category: row.get('category'),
    lines: row.get('lines') || [],
    total: Number(row.get('total') || 0),
    paid: Number(row.get('paid') || 0),
    owed: owedOn(row),
    status: row.get('voidedAt') ? 'void' : row.get('status'),
    invoice: row.get('invoice') || '',
    notes: row.get('notes') || '',
    payments: payments.map((entry) => ({ ...entry, at: entry.at })),
    recordedBy: nameOf(row.get('recordedBy')),
    voidReason: row.get('voidReason') || '',
  };
}

const statusOf = (total, paid) => (paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid');

// Lines: [{ description, quantity, unitCost }] → priced lines and the total.
function linesOf(value) {
  if (!Array.isArray(value) || !value.length) throw invalid('Add at least one line');
  if (value.length > 50) throw invalid('A purchase can have at most 50 lines');
  const lines = value.map((line) => {
    const description = clean(line?.description, 120);
    if (!description) throw invalid('Each line needs a description');
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000)
      throw invalid(`${description}: enter the quantity`);
    const unitCost = amountOf(line.unitCost, `${description} unit cost`, { allowZero: true });
    return {
      description,
      quantity: Math.round(quantity * 1000) / 1000,
      unit: clean(line.unit, 20),
      unitCost,
      total: Math.round(quantity * unitCost),
    };
  });
  return { lines, total: lines.reduce((n, line) => n + line.total, 0) };
}

// Owner / finance: record a purchase. A line may name its stock item
// (`itemId`, stock.js).
// { day, supplierId, branchId?, category, lines, paid, method, invoice, notes }
Parse.Cloud.define('recordPurchase', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  const supplier = await supplierParam(p.supplierId, { required: true });
  if (supplier.get('active') === false) throw invalid('That supplier is archived');
  const category = PURCHASE_CATEGORIES.includes(p.category) ? p.category : 'other';
  const priced = linesOf(p.lines);
  const { total } = priced;
  if (!total) throw invalid('The purchase total is zero');
  const paid = amountOf(p.paid ?? 0, 'amount paid', { allowZero: true });
  if (paid > total) throw invalid('Paid more than the total');
  const day = dayOf(p.day, config);
  const { lines, linked } = await require('./stock').linkPurchaseLines(priced.lines, p.lines, day);
  const branch = p.branchId ? await branchParam(p.branchId) : await branchFor(null);
  const method = methodOf(p.method);
  const row = new Parse.Object('Purchase');
  row.set({
    purchaseCode: await nextDailyCode('PU', 3, config.timezone, {
      className: 'Purchase',
      field: 'purchaseCode',
    }),
    day,
    spentAt: instantOf(day, config),
    supplier,
    supplierName: supplier.get('name'),
    category,
    lines,
    stockLinked: linked,
    total,
    paid,
    status: statusOf(total, paid),
    invoice: clean(p.invoice, 60),
    notes: clean(p.notes, 300),
    payments: paid
      ? [
          {
            amount: paid,
            method,
            day,
            at: new Date().toISOString(),
            by: nameOf(await actor.fetch(MASTER)),
          },
        ]
      : [],
    recordedBy: actor,
    ...(branch && { branch }),
  });
  row.setACL(readAcl(null, ACL_ROLES));
  await row.save(null, MASTER);
  await audit(actor, 'purchase.recorded', row, null, {
    supplier: supplier.get('name'),
    total,
    paid,
    method,
    day,
  });
  return purchaseView(row);
});

// Owner / finance: pay (part of) what a purchase still owes.
// { purchaseId, amount, method, day }
Parse.Cloud.define('payPurchase', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  const row = await new Parse.Query('Purchase')
    .get(String(p.purchaseId || ''), MASTER)
    .catch(() => null);
  if (!row || row.get('voidedAt')) throw invalid('Unknown purchase');
  const owed = owedOn(row);
  if (!owed) throw invalid('This purchase is already paid');
  const amount = amountOf(p.amount, 'amount paid');
  if (amount > owed) throw invalid('That is more than is owed on it');
  const method = methodOf(p.method);
  const day = dayOf(p.day, config);
  const before = { paid: row.get('paid'), status: row.get('status') };
  const paid = Number(row.get('paid') || 0) + amount;
  row.set({
    paid,
    status: statusOf(Number(row.get('total')), paid),
    payments: [
      ...(row.get('payments') || []),
      { amount, method, day, at: new Date().toISOString(), by: nameOf(await actor.fetch(MASTER)) },
    ],
  });
  await row.save(null, MASTER);
  await audit(actor, 'purchase.paid', row, before, { paid, amount, method, day });
  return purchaseView(row);
});

async function voidRecord(className, request, action) {
  const { user: actor } = await requireFinance(request);
  const reason = clean(request.params.reason, 200);
  if (reason.length < 3) throw invalid('Say why it is being voided');
  const row = await new Parse.Query(className)
    .get(String(request.params.id || ''), MASTER)
    .catch(() => null);
  if (!row) throw invalid('Not found');
  if (row.get('voidedAt')) throw invalid('Already voided');
  row.set({ voidedAt: new Date(), voidReason: reason, voidedBy: actor });
  await row.save(null, MASTER);
  await audit(actor, action, row, { voided: false }, { voided: true, reason });
  return row;
}

Parse.Cloud.define('voidPurchase', async (request) =>
  purchaseView(await voidRecord('Purchase', request, 'purchase.voided')),
);

// { from, to, branchId?, supplierId?, status?: 'owed' }
Parse.Cloud.define('listPurchases', async (request) => {
  await requireFinance(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config);
  const query = new Parse.Query('Purchase');
  query.greaterThanOrEqualTo('spentAt', range.start);
  query.lessThan('spentAt', range.end);
  const branch = await branchParam(p.branchId);
  if (branch) query.equalTo('branch', branch);
  const supplier = await supplierParam(p.supplierId);
  if (supplier) query.equalTo('supplier', supplier);
  query.include(['supplier', 'recordedBy']);
  const rows = (await findAll(query))
    .sort((a, b) => b.get('spentAt') - a.get('spentAt') || b.createdAt - a.createdAt)
    .map(purchaseView)
    .filter((row) => p.status !== 'owed' || row.owed > 0);
  const live = rows.filter((row) => row.status !== 'void');
  return {
    range: { from: range.from, to: range.to },
    purchases: rows,
    summary: {
      count: live.length,
      total: live.reduce((n, row) => n + row.total, 0),
      paid: live.reduce((n, row) => n + row.paid, 0),
      owed: live.reduce((n, row) => n + row.owed, 0),
    },
  };
});

// ---------------------------------------------------------------------------
// Expenses

function expenseView(row) {
  return {
    id: row.id,
    code: row.get('expenseCode'),
    day: row.get('day'),
    category: row.get('category'),
    description: row.get('description'),
    amount: Number(row.get('amount') || 0),
    method: row.get('method'),
    branchId: row.get('branch')?.id || '',
    supplierId: row.get('supplier')?.id || '',
    payee: row.get('payee') || row.get('supplier')?.get?.('name') || '',
    reference: row.get('reference') || '',
    status: row.get('voidedAt') ? 'void' : 'recorded',
    recordedBy: nameOf(row.get('recordedBy')),
    voidReason: row.get('voidReason') || '',
  };
}

// { day, category, description, amount, method, branchId?, supplierId?, payee, reference }
Parse.Cloud.define('recordExpense', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  if (!EXPENSE_CATEGORIES.includes(p.category)) throw invalid('Choose the kind of expense');
  const description = clean(p.description, 160);
  if (description.length < 2) throw invalid('Say what the expense was for');
  const amount = amountOf(p.amount, 'amount');
  const day = dayOf(p.day, config);
  const method = methodOf(p.method);
  const branch = p.branchId ? await branchParam(p.branchId) : await branchFor(null);
  const supplier = await supplierParam(p.supplierId);
  const row = new Parse.Object('Expense');
  row.set({
    expenseCode: await nextDailyCode('EX', 3, config.timezone, {
      className: 'Expense',
      field: 'expenseCode',
    }),
    day,
    spentAt: instantOf(day, config),
    category: p.category,
    description,
    amount,
    method,
    payee: clean(p.payee, 80),
    reference: clean(p.reference, 60),
    recordedBy: actor,
    ...(branch && { branch }),
    ...(supplier && { supplier }),
  });
  row.setACL(readAcl(null, ACL_ROLES));
  await row.save(null, MASTER);
  await audit(actor, 'expense.recorded', row, null, {
    category: p.category,
    description,
    amount,
    method,
    day,
  });
  return expenseView(row);
});

Parse.Cloud.define('voidExpense', async (request) =>
  expenseView(await voidRecord('Expense', request, 'expense.voided')),
);

// { from, to, branchId?, category? }
Parse.Cloud.define('listExpenses', async (request) => {
  await requireFinance(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config);
  const query = new Parse.Query('Expense');
  query.greaterThanOrEqualTo('spentAt', range.start);
  query.lessThan('spentAt', range.end);
  const branch = await branchParam(p.branchId);
  if (branch) query.equalTo('branch', branch);
  if (p.category) {
    if (!EXPENSE_CATEGORIES.includes(p.category)) throw invalid('Unknown kind of expense');
    query.equalTo('category', p.category);
  }
  query.include(['supplier', 'recordedBy']);
  const rows = (await findAll(query))
    .sort((a, b) => b.get('spentAt') - a.get('spentAt') || b.createdAt - a.createdAt)
    .map(expenseView);
  const live = rows.filter((row) => row.status !== 'void');
  const byCategory = {};
  for (const row of live) byCategory[row.category] = (byCategory[row.category] || 0) + row.amount;
  return {
    range: { from: range.from, to: range.to },
    expenses: rows,
    summary: {
      count: live.length,
      total: live.reduce((n, row) => n + row.amount, 0),
      byCategory: Object.entries(byCategory)
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
    },
  };
});

module.exports = {
  requireFinance,
  owedOn,
  PURCHASE_CATEGORIES,
  EXPENSE_CATEGORIES,
  METHODS,
};
