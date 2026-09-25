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
  return counter.get('value');
}

// e.g. ORD-20260925-0001, restarting each day in the restaurant timezone.
async function nextDailyCode(prefix, digits, timezone) {
  const day = dateKey(new Date(), timezone);
  const sequence = await nextSequence(`${prefix}:${day}`);
  return `${prefix}-${day}-${String(sequence).padStart(digits, '0')}`;
}

// e.g. R-001 for riders, C-001 for cashiers.
async function nextStaffCode(role) {
  const prefix = role === 'rider' ? 'R' : 'C';
  const sequence = await nextSequence(`staff:${prefix}`);
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

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
  nextStaffCode,
};
