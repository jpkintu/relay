// Tables (eat-in ordering from a QR code on the table). The owner adds the
// restaurant's tables in Admin → Online orders and prints a card for each:
// its QR code opens the online menu for that table (online.js), and what the
// guest orders goes to the kitchen as an eat-in order for that table, paid
// later at the counter like any open bill. Staff move an order to another
// table when the guests move.
//
// Each table has a secret token in its QR code, so an order can only come
// from someone who can see the card. A new code (when a card is lost or
// copied) stops the old one working.

const crypto = require('crypto');
const { MASTER, invalid, requireRole, requireCashierShift, audit, findAll } = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');

const CLASS = 'DiningTable';
const ID = /^[A-Za-z0-9]{1,32}$/;
const TOKEN = /^[a-f0-9]{24}$/;
// Eat-in orders still being prepared, served or paid.
const DONE = ['DELIVERED', 'CANCELLED'];

const newToken = () => crypto.randomBytes(12).toString('hex');
const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

const view = (row, withToken) => ({
  id: row.id,
  name: row.get('name'),
  branchId: row.get('branch')?.id || '',
  active: row.get('active') !== false,
  ...(withToken && { token: row.get('token') }),
});

async function allTables() {
  const rows = await findAll(new Parse.Query(CLASS));
  return rows.sort(
    (a, b) =>
      (a.get('sortOrder') || 0) - (b.get('sortOrder') || 0) ||
      String(a.get('name')).localeCompare(String(b.get('name')), undefined, { numeric: true }),
  );
}

// The open table a QR code belongs to, or an error for the guest.
async function tableByToken(token) {
  const value = String(token || '');
  const row = TOKEN.test(value)
    ? await new Parse.Query(CLASS).equalTo('token', value).first(MASTER)
    : null;
  if (!row || row.get('active') === false)
    throw invalid('This table’s QR code is no longer in use. Ask a member of staff');
  return row;
}

// Owner: the tables with their QR codes.
Parse.Cloud.define('adminListTables', async (request) => {
  await requireAdminUnlock(request);
  return { tables: (await allTables()).map((row) => view(row, true)) };
});

// Owner: add or rename a table, open or close it, or give it a new QR code
// (the old one stops working). { id?, name, branchId?, active?, newCode? }
Parse.Cloud.define('adminSaveTable', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const name = clean(p.name, 30);
  if (!name) throw invalid('Give the table a name or number, e.g. Table 5');
  const branches = require('./branches');
  const rows = await allTables();
  const row = p.id ? rows.find((r) => r.id === p.id) : new Parse.Object(CLASS);
  if (!row) throw invalid('Unknown table');
  const branch =
    p.branchId !== undefined
      ? (await branches.branchParam(p.branchId)) || (await branches.mainBranch())
      : row.get('branch') || (await branches.mainBranch());
  if (
    rows.some(
      (r) =>
        r.id !== row.id &&
        r.get('name').toLowerCase() === name.toLowerCase() &&
        (r.get('branch')?.id || '') === (branch?.id || ''),
    )
  )
    throw invalid(`There is already a table called "${name}"`);
  const before = p.id ? view(row) : null;
  row.set({
    name,
    active: p.active === undefined ? row.get('active') !== false : p.active === true,
    sortOrder: p.id ? row.get('sortOrder') || 0 : rows.length,
  });
  if (branch) row.set('branch', branch);
  if (!p.id || p.newCode === true) row.set('token', newToken());
  row.setACL(new Parse.ACL());
  await row.save(null, MASTER);
  await audit(actor, p.id ? 'table.updated' : 'table.created', row, before, {
    ...view(row),
    ...(p.newCode === true && { newCode: true }),
  });
  return view(row, true);
});

// Staff: the open tables (cashiers: their branch's), to move an order.
Parse.Cloud.define('getTables', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  const own = role === 'cashier' ? (await require('./branches').branchFor(user))?.id : null;
  return {
    tables: (await allTables())
      .filter((row) => row.get('active') !== false)
      .filter((row) => !own || !row.get('branch') || row.get('branch').id === own)
      .map((row) => view(row)),
  };
});

// Cashier/owner: the guests moved; the order (and its bill) goes with them.
// { orderId, tableId }
Parse.Cloud.define('moveOrderTable', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(user, role);
  const p = request.params || {};
  const order = ID.test(String(p.orderId || ''))
    ? await new Parse.Query('Order').get(p.orderId, MASTER).catch(() => null)
    : null;
  if (!order) throw invalid('Order not found');
  if (order.get('orderType') !== 'eat_in') throw invalid('Only eat-in orders sit at a table');
  if (DONE.includes(order.get('status')) && !order.get('billOpen'))
    throw invalid('This order is finished');
  const table = ID.test(String(p.tableId || ''))
    ? await new Parse.Query(CLASS).get(p.tableId, MASTER).catch(() => null)
    : null;
  if (!table || table.get('active') === false) throw invalid('Choose an open table');
  const branchId = order.get('branch')?.id;
  if (branchId && table.get('branch') && table.get('branch').id !== branchId)
    throw invalid('That table is at another branch');
  if (order.get('table')?.id === table.id)
    throw invalid(`The order is already at ${table.get('name')}`);
  const before = { table: order.get('tableLabel') || '' };
  order.set({ table, tableLabel: table.get('name') });
  await order.save(null, MASTER);
  await audit(user, 'order.table_moved', order, before, { table: table.get('name') });
  return { table: table.get('name') };
});

module.exports = { tableByToken, TABLE_CLASS: CLASS };
