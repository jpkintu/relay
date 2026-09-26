// Shared Cloud Code helpers: auth, roles, ACLs, audit, configuration and
// sequential codes. Every business write happens through Cloud functions with
// the master key; clients only read (see security.js).

const { dateKey } = require('./dates');

const MASTER = { useMasterKey: true };
const ROLE_NAMES = ['admin', 'cashier', 'rider'];

const DEFAULT_CONFIG = {
  restaurantName: 'Restaurant',
  currencySymbol: 'UGX',
  currencyCode: 'UGX',
  timezone: 'Africa/Kampala',
  defaultDeliveryFee: 3000,
  maxRiderFloat: 200000,
  allowBatching: false,
  commissionRounding: 'none',
  requireCashierConfirmForPickup: false,
  airtelMerchantCode: '',
  airtelMerchantName: '',
  mtnMerchantCode: '',
  mtnMerchantName: '',
  // Hour of the day (restaurant time) to remind riders to hand over cash.
  cashReminderHour: 20,
  // Warn riders when their cash reaches this % of maxRiderFloat.
  floatWarningPercent: 80,
};

const forbidden = (message) => new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, message);
const invalid = (message) => new Parse.Error(Parse.Error.SCRIPT_FAILED, message);

function requireUser(request) {
  if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in required');
  if (request.user.get('active') === false) throw forbidden('Account is inactive');
  return request.user;
}

// Highest-privilege role the user holds: admin > cashier > rider, else null.
async function getRoleName(user) {
  const query = new Parse.Query(Parse.Role);
  query.containedIn('name', ROLE_NAMES);
  query.equalTo('users', user);
  const names = (await query.find(MASTER)).map((role) => role.getName());
  return ROLE_NAMES.find((name) => names.includes(name)) || null;
}

async function requireRole(request, allowed) {
  const user = requireUser(request);
  const role = await getRoleName(user);
  if (!allowed.includes(role)) throw forbidden(`${allowed.join(' or ')} role required`);
  return { user, role };
}

const isRider = async (user) => (await getRoleName(user)) === 'rider';
const isStaff = async (user) => ['cashier', 'admin'].includes(await getRoleName(user));
const adminOnly = async (request) => (await requireRole(request, ['admin'])).user;

async function ensureRole(name) {
  const query = new Parse.Query(Parse.Role);
  query.equalTo('name', name);
  let role = await query.first(MASTER);
  if (!role) {
    const acl = new Parse.ACL();
    acl.setRoleReadAccess('admin', true);
    acl.setRoleWriteAccess('admin', true);
    role = new Parse.Role(name, acl);
    await role.save(null, MASTER);
  }
  return role;
}

// Read-only ACL: the owning user (if any) plus the given roles. Nobody gets
// client write access; Cloud functions write with the master key.
function readAcl(owner, roles = ['cashier', 'admin']) {
  const acl = new Parse.ACL();
  if (owner) acl.setReadAccess(owner, true);
  for (const role of roles) acl.setRoleReadAccess(role, true);
  return acl;
}

// Users can read and write themselves (password changes are still filtered by
// the _User beforeSave guard); admins manage everyone; cashiers can read
// riders so handovers and tickets can show names.
function userAcl(user, role) {
  const acl = new Parse.ACL();
  acl.setReadAccess(user, true);
  acl.setWriteAccess(user, true);
  acl.setRoleReadAccess('admin', true);
  acl.setRoleWriteAccess('admin', true);
  if (role === 'rider') acl.setRoleReadAccess('cashier', true);
  return acl;
}

async function audit(actor, action, object, before, after) {
  const log = new Parse.Object('AuditLog');
  log.set({
    actor,
    action,
    entityType: object.className,
    entityId: object.id,
    beforeJson: JSON.stringify(before || {}),
    afterJson: JSON.stringify(after || {}),
  });
  log.setACL(readAcl(null, ['admin']));
  await log.save(null, MASTER);
}

async function loadConfig() {
  const object = await new Parse.Query('Configuration').first(MASTER);
  const values = { ...DEFAULT_CONFIG };
  if (object) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const value = object.get(key);
      if (value !== undefined && value !== null && value !== '') values[key] = value;
    }
  }
  return { object, values };
}

// Count with a filter: Parse's Postgres adapter returns an estimate for an
// unfiltered count, which is wrong on small tables.
function countUsers() {
  const query = new Parse.Query(Parse.User);
  query.exists('username');
  return query.count(MASTER);
}

// Cash the rider is still accountable for: delivered cash orders that have
// not been reconciled. Derived from orders, never stored.
async function riderFloat(rider) {
  const query = new Parse.Query('Order');
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  query.limit(1000);
  const orders = await query.find(MASTER);
  return orders.reduce((sum, order) => sum + (Number(order.get('amountCollected')) || 0), 0);
}

// Cashiers work the board only during a shift that started with a counted
// till, so every action falls inside a shift that is reconciled at the end.
// Admins (the owner) are not till operators and are not held to this.
async function requireCashierShift(user, role) {
  if (role !== 'cashier') return;
  const query = new Parse.Query('Shift');
  query.equalTo('operator', user);
  query.equalTo('kind', 'cashier');
  query.equalTo('status', 'open');
  if (!(await query.first(MASTER)))
    throw invalid('Start your shift and count the cash in the till first');
}

// "R-001 · Rita" style label for notifications and ledgers.
const personName = (user) =>
  user
    ? [user.get('riderCode') || user.get('cashierCode'), user.get('name') || user.get('username')]
        .filter(Boolean)
        .join(' · ')
    : '';

// Atomic counter. Two callers racing to create the same key both end up
// incrementing the earliest-created row, so values stay unique.
async function nextSequence(key) {
  const find = () => {
    const query = new Parse.Query('Counter');
    query.equalTo('key', key);
    query.ascending('createdAt');
    return query.first(MASTER);
  };
  if (!(await find())) {
    const created = new Parse.Object('Counter');
    created.set({ key, value: 0 });
    created.setACL(new Parse.ACL());
    await created.save(null, MASTER);
  }
  const counter = await find();
  counter.increment('value');
  await counter.save(null, MASTER);
  const value = Number(counter.get('value'));
  if (Number.isInteger(value) && value > 0) return value;
  // Some hosts (Back4App) do not return the incremented value from save(),
  // which produced codes like "ORD-20260925-[object Object]". Read it back;
  // callers also check the code is unused.
  const stored = Number((await find()).get('value'));
  if (Number.isInteger(stored) && stored > 0) return stored;
  // The stored value itself is unusable: restart it and let the callers skip
  // codes that are already taken.
  const reset = await find();
  reset.set('value', 1);
  await reset.save(null, MASTER);
  return 1;
}

// Keeps drawing from the sequence until the code is not already used.
async function uniqueCode(key, format, taken) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = format(await nextSequence(key));
    if (!(await taken(code))) return code;
  }
  throw new Error(`Could not allocate a unique code for ${key}`);
}

const codeTakenIn = (className, field) => async (code) => {
  const query = new Parse.Query(className);
  query.equalTo(field, code);
  try {
    return !!(await query.first(MASTER));
  } catch (error) {
    // Postgres: the column does not exist until the first code is saved.
    const detail = error?.message && typeof error.message === 'object' ? error.message : error;
    if (detail?.code === '42703' || /does not exist/.test(String(detail?.message))) return false;
    throw error;
  }
};

// e.g. ORD-20260925-0001, restarting each day in the restaurant timezone.
// `className`/`field` name where the code is stored, to guarantee it is unused;
// `date` picks the day (defaults to now).
async function nextDailyCode(prefix, digits, timezone, { className, field, date } = {}) {
  const day = dateKey(date || new Date(), timezone);
  const taken = className ? codeTakenIn(className, field) : async () => false;
  return uniqueCode(
    `${prefix}:${day}`,
    (n) => `${prefix}-${day}-${String(n).padStart(digits, '0')}`,
    taken,
  );
}

// e.g. R-001 for riders, C-001 for cashiers.
async function nextStaffCode(role) {
  const prefix = role === 'rider' ? 'R' : 'C';
  return uniqueCode(
    `staff:${prefix}`,
    (n) => `${prefix}-${String(n).padStart(3, '0')}`,
    codeTakenIn(Parse.User, role === 'rider' ? 'riderCode' : 'cashierCode'),
  );
}

// A code produced by the old bug ("…[object Object]") or otherwise not in the
// expected shape.
const isBrokenCode = (code) => typeof code === 'string' && /object|undefined|NaN/.test(code);

module.exports = {
  MASTER,
  DEFAULT_CONFIG,
  forbidden,
  invalid,
  requireUser,
  getRoleName,
  requireRole,
  isRider,
  isStaff,
  adminOnly,
  ensureRole,
  readAcl,
  userAcl,
  audit,
  loadConfig,
  countUsers,
  nextDailyCode,
  riderFloat,
  personName,
  requireCashierShift,
  isBrokenCode,
  nextStaffCode,
};
