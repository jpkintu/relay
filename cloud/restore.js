// Owner: put records back from a backup file (Admin → Data & privacy →
// Restore). The app reads the file and sends it a class at a time, in small
// batches, in the order below; each batch is safe to send again.
//
// - A record still here (same id) is left as it is: only what is missing
//   comes back. Restoring into a new, empty app brings everything back.
// - Parse gives restored records new ids. Each keeps the id it had in the
//   backup (`restoredFrom`), so links between records (an order's rider, a
//   line's order, a handover's orders) are rebuilt; a link whose record is
//   not restored yet is kept in `restoreLinks` and fixed by the last step.
// - Records are created visible to nobody but the server; the last step
//   applies the normal access rules (Apply security rules).
// - Team members get new PINs (a backup holds no PINs), shown once.
// - Creation times cannot be set on Parse; the original is kept in
//   `restoredCreatedAt` and reports use it (lib/placed.js).

const crypto = require('crypto');
const { MASTER, audit, ensureRole, invalid, userAcl } = require('./lib/core');
const { fullUsername, displayUsername } = require('./lib/tenant');
const { requireAdminUnlock } = require('./adminLock');
const { EXPORT_CLASSES } = require('./data');
const { applySecurity } = require('./security');

// Classes a record may link to come first.
const ORDER = [
  'Configuration',
  'Branch',
  '_User',
  'MenuCategory',
  'Accompaniment',
  'MenuItem',
  'Customer',
  'DiningTable',
  'Shift',
  'TillPayout',
  'Order',
  'OrderItem',
  'CashHandover',
  'Voucher',
  'ZReport',
  'Supplier',
  'Purchase',
  'Expense',
  'StockItem',
  'StockCount',
  'AuditLog',
];
const BATCH = 200;
const ID = /^[A-Za-z0-9]{1,32}$/;
// Never copied from a backup row.
const SKIP_FIELDS = new Set([
  'objectId',
  'createdAt',
  'updatedAt',
  'ACL',
  'tenant',
  'restoredFrom',
  'restoredCreatedAt',
  'restoreLinks',
  'sessionToken',
  'authData',
  'password',
  '_hashed_password',
]);
// Team fields a backup carries (data.js); everything else stays unset.
const USER_FIELDS = [
  'name',
  'phone',
  'email',
  'active',
  'riderCode',
  'cashierCode',
  'financeCode',
  'commissionType',
  'commissionPerOrder',
  'commissionPercent',
  'maxFloat',
  'available',
];
const ROLES = ['admin', 'finance', 'cashier', 'rider'];

// Lists of links, which the backup file writes as { objectId } only.
const ARRAY_LINKS = {
  CashHandover: { orders: 'Order', returnedOrders: 'Order' },
  TillPayout: { orders: 'Order', shortages: 'CashHandover' },
};

// The app's backup file (format 1) writes a link as { objectId } and a date
// as plain text, without saying what they are; the class's own field types
// here say it, so older and newer backups restore the same way.
async function fieldsOf(className) {
  const schema = await new Parse.Schema(className).get(MASTER).catch(() => null);
  return schema?.fields || {};
}
const idOf = (value) =>
  value && typeof value === 'object' && typeof value.objectId === 'string' ? value.objectId : null;
function normalise(className, row, fields) {
  const out = {};
  for (const [field, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    const type = fields[field];
    const listOf = ARRAY_LINKS[className]?.[field];
    if (listOf && Array.isArray(value))
      out[field] = value.map((entry) => (idOf(entry) ? pointer(listOf, idOf(entry)) : entry));
    else if (type?.type === 'Pointer' && idOf(value))
      out[field] = pointer(type.targetClass, idOf(value));
    else if (type?.type === 'Date' && typeof value === 'string')
      out[field] = { __type: 'Date', iso: value };
    else if (type?.type === 'File' && value && typeof value === 'object' && !value.__type)
      out[field] = { __type: 'File', name: value.name, url: value.url };
    else if (type?.type === 'GeoPoint' && value && typeof value === 'object' && !value.__type)
      out[field] = { __type: 'GeoPoint', latitude: value.latitude, longitude: value.longitude };
    else out[field] = value;
  }
  return out;
}

const isPointer = (value) =>
  value && typeof value === 'object' && value.__type === 'Pointer' && ID.test(value.objectId);
const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });

// Ids kept as plain strings rather than pointers: the accompaniments of an
// order line and of a dish's choice groups.
function withIdPointers(className, row) {
  const out = { ...row };
  if (className === 'OrderItem' && Array.isArray(row.accompanimentIds))
    out.accompanimentIds = row.accompanimentIds.map((id) => pointer('Accompaniment', String(id)));
  if (className === 'MenuItem' && Array.isArray(row.accompanimentGroups))
    out.accompanimentGroups = row.accompanimentGroups.map((group) => ({
      ...group,
      options: (group?.options || []).map((id) => pointer('Accompaniment', String(id))),
    }));
  return out;
}
function withoutIdPointers(className, fields) {
  const out = { ...fields };
  if (className === 'OrderItem' && Array.isArray(out.accompanimentIds))
    out.accompanimentIds = out.accompanimentIds.map((p) => (isPointer(p) ? p.objectId : p));
  if (className === 'MenuItem' && Array.isArray(out.accompanimentGroups))
    out.accompanimentGroups = out.accompanimentGroups.map((group) => ({
      ...group,
      options: (group.options || []).map((p) => (isPointer(p) ? p.objectId : p)),
    }));
  return out;
}

function collectPointers(value, into) {
  if (Array.isArray(value)) value.forEach((entry) => collectPointers(entry, into));
  else if (isPointer(value)) {
    if (!into.has(value.className)) into.set(value.className, new Set());
    into.get(value.className).add(value.objectId);
  } else if (value && typeof value === 'object' && !value.__type)
    Object.values(value).forEach((entry) => collectPointers(entry, into));
}

// For each linked class: backup id → the id here (the same record if it is
// still here, else the one restored from it).
async function resolveIds(wanted) {
  const map = new Map();
  for (const [className, ids] of wanted) {
    const list = [...ids];
    const found = new Map();
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const kept = new Parse.Query(className === '_User' ? Parse.User : className);
      kept.containedIn('objectId', part);
      kept.select('objectId');
      kept.limit(part.length);
      const restored = new Parse.Query(className === '_User' ? Parse.User : className);
      restored.containedIn('restoredFrom', part);
      restored.select('restoredFrom');
      restored.limit(part.length);
      const [a, b] = await Promise.all([
        kept.find(MASTER).catch(() => []),
        restored.find(MASTER).catch(() => []),
      ]);
      for (const row of a) found.set(row.id, row.id);
      for (const row of b) found.set(row.get('restoredFrom'), row.id);
    }
    map.set(className, found);
  }
  return map;
}

// Replaces backup ids with the ids here. Links not restored yet stay as they
// were and are reported, so the last step can fix them.
function relink(value, map, missing) {
  if (Array.isArray(value)) return value.map((entry) => relink(entry, map, missing));
  if (isPointer(value)) {
    const id = map.get(value.className)?.get(value.objectId);
    if (id) return pointer(value.className, id);
    missing.found = true;
    return value;
  }
  if (value && typeof value === 'object' && !value.__type) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = relink(entry, map, missing);
    return out;
  }
  return value;
}

const decode = (field, value) => Parse._decode(field, value);
const dateOf = (value) => {
  const iso = typeof value === 'string' ? value : value?.iso;
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};
const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Settings: a backup from another app replaces this app's settings; the
// settings of this same app (same id) are left alone.
async function restoreSettings(rows) {
  const row = rows[0];
  if (!row) return { created: 0, updated: 0, skipped: 0 };
  const here = new Parse.Query('Configuration');
  if (ID.test(String(row.objectId || ''))) {
    const same = await here.get(String(row.objectId), MASTER).catch(() => null);
    if (same) return { created: 0, updated: 0, skipped: 1 };
  }
  const config =
    (await new Parse.Query('Configuration').first(MASTER)) || new Parse.Object('Configuration');
  const fields = await fieldsOf('Configuration');
  for (const [field, value] of Object.entries(normalise('Configuration', row, fields)))
    if (!SKIP_FIELDS.has(field)) config.set(field, decode(field, value));
  if (!config.id) config.setACL(new Parse.ACL());
  await config.save(null, MASTER);
  return { created: 0, updated: 1, skipped: 0 };
}

// Team: people still here (same id or same username) are matched, not
// duplicated; the others are created with a new PIN each.
async function restoreTeam(rows) {
  const result = { created: 0, updated: 0, skipped: 0, pins: [] };
  // Relay Hosted: stored as name@restaurant-code, whatever restaurant the
  // backup came from.
  const fullName = (name) => fullUsername(displayUsername(name));
  for (const row of rows) {
    const oldId = String(row.objectId || '');
    if (!ID.test(oldId)) continue;
    if (await new Parse.Query(Parse.User).get(oldId, MASTER).catch(() => null)) {
      result.skipped += 1;
      continue;
    }
    const restored = await new Parse.Query(Parse.User)
      .equalTo('restoredFrom', oldId)
      .first(MASTER)
      .catch(() => null);
    if (restored) {
      result.skipped += 1;
      continue;
    }
    const username = String(row.username || '')
      .trim()
      .toLowerCase();
    if (!/^[-a-z0-9_.@]{3,64}$/.test(username)) continue;
    const existing = await new Parse.Query(Parse.User)
      .equalTo('username', fullName(username))
      .first(MASTER);
    if (existing) {
      existing.set('restoredFrom', oldId);
      await existing.save(null, MASTER);
      result.updated += 1;
      continue;
    }
    const role = ROLES.includes(row.role) ? row.role : null;
    const pin = newPin();
    const user = new Parse.User();
    user.set({ username: fullName(username), password: pin, restoredFrom: oldId });
    for (const field of USER_FIELDS) if (row[field] !== undefined) user.set(field, row[field]);
    const created = dateOf(row.createdAt);
    if (created) user.set('restoredCreatedAt', created);
    await user.signUp(null, MASTER);
    user.setACL(userAcl(user, role));
    await user.save(null, MASTER);
    if (role) {
      const roleRow = await ensureRole(role);
      roleRow.getUsers().add(user);
      await roleRow.save(null, MASTER);
    }
    result.created += 1;
    result.pins.push({ username, name: row.name || username, role: role || 'none', pin });
  }
  return result;
}

async function restoreRecords(className, rows) {
  const result = { created: 0, updated: 0, skipped: 0 };
  const valid = rows.filter((row) => ID.test(String(row?.objectId || '')));
  const ids = valid.map((row) => String(row.objectId));
  // Still here, or restored by an earlier (repeated) batch.
  const [kept, done] = await Promise.all([
    new Parse.Query(className)
      .containedIn('objectId', ids)
      .select('objectId')
      .limit(ids.length)
      .find(MASTER),
    new Parse.Query(className)
      .containedIn('restoredFrom', ids)
      .select('restoredFrom')
      .limit(ids.length)
      .find(MASTER),
  ]);
  const skip = new Set([...kept.map((r) => r.id), ...done.map((r) => r.get('restoredFrom'))]);
  const todo = valid.filter((row) => !skip.has(String(row.objectId)));
  result.skipped = valid.length - todo.length;
  if (!todo.length) return result;

  const fields = await fieldsOf(className);
  const prepared = todo.map((row) => withIdPointers(className, normalise(className, row, fields)));
  const wanted = new Map();
  for (const row of prepared)
    for (const [field, value] of Object.entries(row))
      if (!SKIP_FIELDS.has(field)) collectPointers(value, wanted);
  const map = await resolveIds(wanted);

  const objects = prepared.map((row) => {
    const object = new Parse.Object(className);
    const links = {};
    const fields = {};
    for (const [field, value] of Object.entries(row)) {
      if (SKIP_FIELDS.has(field) || value === undefined) continue;
      const missing = { found: false };
      fields[field] = relink(value, map, missing);
      if (missing.found) links[field] = value;
    }
    for (const [field, value] of Object.entries(withoutIdPointers(className, fields)))
      if (!(field in links)) object.set(field, decode(field, value));
    object.set('restoredFrom', String(row.objectId));
    const created = dateOf(row.createdAt);
    if (created) object.set('restoredCreatedAt', created);
    // Kept as text, so the links read back exactly as written.
    if (Object.keys(links).length) object.set('restoreLinks', { json: JSON.stringify(links) });
    object.setACL(new Parse.ACL());
    return object;
  });
  await Parse.Object.saveAll(objects, MASTER);
  result.created = objects.length;
  return result;
}

// { className, rows } → { created, updated, skipped, pins? }
Parse.Cloud.define('adminRestoreData', async (request) => {
  await requireAdminUnlock(request);
  const { className, rows } = request.params || {};
  if (!ORDER.includes(className) || !EXPORT_CLASSES.includes(className))
    throw invalid('Unknown kind of record');
  if (!Array.isArray(rows)) throw invalid('No records');
  if (rows.length > BATCH) throw invalid(`At most ${BATCH} records at a time`);
  if (className === 'Configuration') return restoreSettings(rows);
  if (className === '_User') return restoreTeam(rows);
  return restoreRecords(className, rows);
});

// Links saved by restoreRecords, already in pointer form.
function linksOf(row) {
  try {
    return JSON.parse(row.get('restoreLinks')?.json || '{}');
  } catch {
    return {};
  }
}

// Last step, repeated until nothing is left: links to records restored
// later are fixed, then the normal access rules are applied once.
// { counts } (from the app, for the audit log) → { fixed, remaining, done }
Parse.Cloud.define('adminRestoreFinish', async (request) => {
  const actor = await requireAdminUnlock(request);
  let fixed = 0;
  for (const className of ORDER.slice(2)) {
    const query = new Parse.Query(className);
    query.exists('restoreLinks');
    query.limit(BATCH);
    const rows = await query.find(MASTER).catch(() => []);
    if (!rows.length) continue;
    const wanted = new Map();
    for (const row of rows) collectPointers(linksOf(row), wanted);
    const map = await resolveIds(wanted);
    for (const row of rows) {
      const links = linksOf(row);
      const fields = {};
      for (const [field, value] of Object.entries(links)) {
        // A link to a record that is not in the backup is dropped.
        const missing = { found: false };
        const linked = relink(value, map, missing);
        if (!missing.found) fields[field] = linked;
      }
      for (const [field, value] of Object.entries(withoutIdPointers(className, fields)))
        row.set(field, decode(field, value));
      row.unset('restoreLinks');
    }
    await Parse.Object.saveAll(rows, MASTER);
    fixed += rows.length;
    return { fixed, remaining: true, done: false };
  }
  const security = await applySecurity();
  await audit(actor, 'data.restored', { className: 'Restore', id: 'backup' }, null, {
    counts: request.params?.counts || {},
    security,
  });
  return { fixed, remaining: false, done: true };
});

module.exports = { RESTORE_ORDER: ORDER };
