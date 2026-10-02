// Owner's data export (Admin → Data & privacy): every business record, a
// page at a time, for a backup file or spreadsheets. Read-only.

const { MASTER, audit, invalid, getRoleName } = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');

// What a backup contains. Left out: login sessions, PIN hashes, device
// push keys, the VAPID secret, counters and demo rows.
const EXPORT_CLASSES = [
  'Configuration',
  'Branch',
  '_User',
  'MenuCategory',
  'MenuItem',
  'Accompaniment',
  'Customer',
  'Order',
  'OrderItem',
  'CashHandover',
  'TillPayout',
  'Shift',
  'ZReport',
  'Supplier',
  'Purchase',
  'Expense',
  'StockItem',
  'StockCount',
  // Table QR codes (tables.js: each table's secret token, so printed cards
  // keep working) and customers' vouchers (vouchers.js).
  'DiningTable',
  'Voucher',
  'AuditLog',
];
const PAGE = 500;
// Team members: the fields the owner manages, never credentials.
const USER_FIELDS = [
  'username',
  'name',
  'phone',
  'email',
  'active',
  'riderCode',
  'cashierCode',
  'financeCode',
  'branch',
  'commissionType',
  'commissionPerOrder',
  'commissionPercent',
  'maxFloat',
  'available',
];

function plain(object) {
  const json = object.toJSON();
  delete json.ACL;
  return json;
}

async function userRow(user) {
  const row = { objectId: user.id, createdAt: user.createdAt, updatedAt: user.updatedAt };
  for (const field of USER_FIELDS) if (user.get(field) !== undefined) row[field] = user.get(field);
  // The branch as its id (a link, not the whole branch record).
  if (row.branch) row.branch = row.branch.id;
  row.role = (await getRoleName(user)) || 'unassigned';
  return row;
}

// { className, after } → { rows, next }. Pages run in objectId order; pass
// `next` back as `after` until it is null.
Parse.Cloud.define('adminExportData', async (request) => {
  const actor = await requireAdminUnlock(request);
  const { className, after } = request.params || {};
  if (!EXPORT_CLASSES.includes(className)) throw invalid('Unknown kind of record');
  if (after !== undefined && after !== null && !/^[A-Za-z0-9]{1,32}$/.test(String(after)))
    throw invalid('Bad page');
  const query = new Parse.Query(className);
  query.ascending('objectId');
  query.limit(PAGE);
  if (after) query.greaterThan('objectId', String(after));
  const found = await query.find(MASTER).catch((error) => {
    // A class that has never had a row does not exist yet on some hosts.
    if (/does not exist|not found/i.test(String(error?.message))) return [];
    throw error;
  });
  const rows =
    className === '_User' ? await Promise.all(found.map(userRow)) : found.map((row) => plain(row));
  if (!after)
    await audit(actor, 'data.exported', { className: 'Export', id: className }, null, {
      className,
    });
  return { rows, next: found.length === PAGE ? found[found.length - 1].id : null };
});

// How many records a backup will hold, so the app can show progress.
Parse.Cloud.define('adminExportSummary', async (request) => {
  await requireAdminUnlock(request);
  const counts = {};
  for (const className of EXPORT_CLASSES) {
    const query = new Parse.Query(className);
    // A filter keeps Postgres from answering with an estimate.
    query.exists('objectId');
    counts[className] = await query.count(MASTER).catch(() => 0);
  }
  return { classes: EXPORT_CLASSES, counts };
});

module.exports = { EXPORT_CLASSES };
