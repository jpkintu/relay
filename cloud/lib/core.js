// Shared Cloud Code helpers: auth, roles, ACLs, audit, configuration and
// sequential codes. Every business write happens through Cloud functions with
// the master key; clients only read (see security.js).

const { dateKey } = require('./dates');

const MASTER = { useMasterKey: true };
// Highest privilege first. Finance: reports, accounting, purchases and
// expenses, tax receipts; none of the owner's sensitive functions (team,
// menu, settings, keys, data) and not the kitchen board.
const ROLE_NAMES = ['admin', 'finance', 'cashier', 'rider'];

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
  // Commission rule given to new riders (each rider's rule can be changed).
  defaultCommissionType: 'per_order',
  defaultCommissionPerOrder: 0,
  defaultCommissionPercent: 0,
  // Hour of the day (restaurant time) after which the daily Z-report is saved.
  zReportHour: 23,
  // Modules (Settings → Modules): riders take orders themselves; cashiers take
  // call-in deliveries and assign a rider; cashiers take eat-in / pick-up.
  moduleRiderOrders: true,
  moduleCallIn: false,
  moduleCounter: false,
  // Printed receipts: paper width in mm (58 or 80), text above and below.
  receiptWidth: 80,
  receiptHeader: '',
  receiptFooter: 'Thank you!',
  // Open the print dialog for the kitchen ticket when a counter order is placed.
  autoPrintKitchen: false,
  // The cash drawer at the counter (drawer.js) and when it opens by itself.
  cashDrawer: false,
  drawerOnSale: true,
  drawerOnHandover: true,
  drawerOnPayout: true,
  drawerOnShift: true,
  // Online orders (online.js): the public menu link and QR code. Off until
  // the owner switches it on; what is offered; paused by staff when busy.
  onlineOrders: false,
  onlineOpen: true,
  onlinePickup: true,
  onlineDelivery: true,
  onlineCash: true,
  onlineMobileMoney: true,
  onlineNote: '',
  // Online deliveries priced by distance from the branch's pin; 0 = the flat fee.
  onlineDeliveryPerKm: 0,
  // Guests order from a QR code on their table (tables.js).
  onlineTables: false,
  // What sending a refund back costs (vouchers.js): flat + % of it.
  refundChargeFlat: 0,
  refundChargePercent: 0,
  // Branding: theme colours (#rrggbb); '' keeps Relay's own.
  themeInk: '',
  themeAccent: '',
  // Where the map opens (the restaurant); Kampala until the owner pins it.
  restaurantLat: 0.3476,
  restaurantLng: 32.5825,
  // Privacy (Admin → Data & privacy): months to keep customer details on
  // finished orders (0 = keep), and who customers contact about their data.
  retentionMonths: 0,
  // Automatic mobile money (Admin → Payments); the keys are in Secret.
  mtnAutoCollect: false,
  // Tax (EFRIS): on/off and the day it was switched on (cloud/efris.js).
  efrisEnabled: false,
  efrisFrom: null,
  // Accounting: cash and bank when the books started (null: not entered).
  openingBalance: null,
  airtelAutoCollect: false,
  momoDialCode: '256',
  // Card payments at the counter (Settings → Card payments).
  cardEnabled: false,
  cardLabel: '',
  cardTerminalId: '',
  cardMerchantName: '',
  privacyContact: '',
  // Admin → Get started: true once the owner finishes it, false when they
  // reopen it, null (not set) to decide from the restaurant's state.
  setupDone: null,
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
  // The restaurant's own logo (Settings), as a public URL; '' when none.
  values.restaurantLogo = fileUrl(object?.get('restaurantLogo')) || '';
  // The sign-in screen's pictures, as public URLs with their captions.
  values.loginImages = (object?.get('loginImages') || [])
    .map((entry) => ({ url: fileUrl(entry?.file) || '', caption: String(entry?.caption || '') }))
    .filter((entry) => entry.url);
  return { object, values };
}

// Count with a filter: Parse's Postgres adapter returns an estimate for an
// unfiltered count, which is wrong on small tables.
function countUsers() {
  const query = new Parse.Query(Parse.User);
  query.exists('username');
  return query.count(MASTER);
}

// Every row a query matches, fetched 1,000 at a time, so totals are never cut
// off at a row limit. The query must not set a sort, skip or limit (sort the
// result in memory instead).
async function findAll(query, options = MASTER) {
  const rows = [];
  await query.eachBatch((batch) => void rows.push(...batch), { ...options, batchSize: 1000 });
  return rows;
}

// Cash the rider is still accountable for: delivered cash orders that have
// not been reconciled. Derived from orders, never stored.
async function riderFloat(rider) {
  const query = new Parse.Query('Order');
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  const orders = await findAll(query);
  return orders.reduce((sum, order) => sum + (Number(order.get('amountCollected')) || 0), 0);
}

// The rider's cash limit: their own override (set by the owner on the rider's
// page) or the restaurant default. Returns config with maxRiderFloat replaced,
// so every limit check and message uses the rider's own figure.
function withRiderLimit(config, rider) {
  const own = rider?.get('maxFloat');
  return typeof own === 'number' && own >= 0 ? { ...config, maxRiderFloat: own } : config;
}

// Parse Server's sign-in lockout (S5: `accountLockout` in the server options,
// docs/ROADMAP.md §2) keeps these two hidden fields on the account. Clearing
// them lets the person sign in again at once instead of after the lockout.
// The in-app PIN lock (verifyPin) is lifted with it.
async function clearSignInLock(user) {
  const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER);
  fresh.set('pinFailures', 0);
  fresh.unset('pinLockedUntil');
  await fresh.save(null, MASTER);
  // As Parse Server unlocks an account itself: straight in the database,
  // past the _User triggers (a save through them drops these hidden fields).
  const unlock = {
    _account_lockout_expires_at: { __op: 'Delete' },
    _failed_login_count: { __op: 'Delete' },
  };
  const database = Parse.Server?.database;
  if (database) await database.update('_User', { objectId: user.id }, unlock);
}

// Signs a user out everywhere (after a PIN reset or change). `keepToken`
// keeps one session alive.
async function endSessions(user, keepToken) {
  const query = new Parse.Query(Parse.Session);
  query.equalTo('user', user);
  query.limit(1000);
  const sessions = (await query.find(MASTER)).filter(
    (session) => !keepToken || session.get('sessionToken') !== keepToken,
  );
  if (sessions.length) await Parse.Object.destroyAll(sessions, MASTER);
  return sessions.length;
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
    ? [
        user.get('riderCode') || user.get('cashierCode') || user.get('financeCode'),
        user.get('name') || user.get('username'),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

// Atomic counter. Two callers racing to create the same key both end up
// incrementing the earliest-created row, so values stay unique.
async function nextSequence(key) {
  const find = () => {
    const query = new Parse.Query('Counter');
    query.equalTo('key', key);
    // Two rows created in the same millisecond must still resolve to the
    // same "earliest" row for every caller, or both would win a claimOnce.
    query.ascending('createdAt');
    query.addAscending('objectId');
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

// Postgres: a query on a field no row has ever had (a column that does not
// exist until "Apply security rules" or the first save) fails. Such a query
// simply matches nothing.
function missingColumn(error) {
  const detail = error?.message && typeof error.message === 'object' ? error.message : error;
  return detail?.code === '42703' || /column .* does not exist/.test(String(detail?.message));
}
const orNone = (fallback) => (error) => {
  if (missingColumn(error)) return fallback;
  throw error;
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
  const prefix = role === 'rider' ? 'R' : role === 'finance' ? 'F' : 'C';
  return uniqueCode(
    `staff:${prefix}`,
    (n) => `${prefix}-${String(n).padStart(3, '0')}`,
    codeTakenIn(
      Parse.User,
      role === 'rider' ? 'riderCode' : role === 'finance' ? 'financeCode' : 'cashierCode',
    ),
  );
}

// True for exactly one caller per key: the first to increment it. Used to make
// "whoever gets there first" steps (claiming an order, reviewing a handover,
// paying a rider) safe when two devices act at the same moment.
async function claimOnce(key) {
  return (await nextSequence(key)) === 1;
}

const PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

// Sensitive steps (handing over cash, ending a shift, paying from the till)
// ask for the PIN again. Five wrong PINs lock these steps for 15 minutes.
async function verifyPin(user, pin) {
  const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER);
  const lockedUntil = fresh.get('pinLockedUntil');
  if (lockedUntil && lockedUntil > new Date()) {
    const minutes = Math.ceil((lockedUntil - new Date()) / 60000);
    throw invalid(`Too many wrong PINs. Try again in ${minutes} min`);
  }
  const value = String(pin ?? '');
  if (!value) throw invalid('Enter your PIN to continue');
  try {
    await Parse.User.verifyPassword(fresh.get('username'), value);
  } catch (error) {
    // Parse Server's sign-in lockout (S5) shares the count with sign-in: while
    // it lasts even the right PIN is refused, which is not another wrong one.
    if (/locked due to multiple failed login attempts/i.test(String(error?.message)))
      throw invalid(
        `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} min, or ask the owner to unlock you`,
      );
    const failures = Number(fresh.get('pinFailures') || 0) + 1;
    const locked = failures >= PIN_ATTEMPTS;
    fresh.set('pinFailures', locked ? 0 : failures);
    if (locked) fresh.set('pinLockedUntil', new Date(Date.now() + PIN_LOCK_MINUTES * 60000));
    await fresh.save(null, MASTER);
    throw invalid(
      locked
        ? `Wrong PIN. Locked for ${PIN_LOCK_MINUTES} min`
        : `Wrong PIN (${PIN_ATTEMPTS - failures} tries left)`,
    );
  }
  if (fresh.get('pinFailures')) {
    fresh.set('pinFailures', 0);
    await fresh.save(null, MASTER);
  }
}

// Kitchen orders belong to one cashier at a time. The first cashier to act on
// an order takes it; others are told who has it and can ask for a transfer.
// Admins can act on any order without taking it. Sets the fields on `order`
// (the caller saves it).
async function takeOrder(order, actor, role) {
  if (role !== 'cashier') return;
  const holder = order.get('cashier');
  if (holder) {
    if (holder.id === actor.id) return;
    throw forbidden(
      `${order.get('cashierName') || 'Another cashier'} is handling this order. Ask them to transfer it to you`,
    );
  }
  if (!(await claimOnce(`order-cashier:${order.id}:${order.get('cashierRound') || 0}`))) {
    const latest = await new Parse.Query('Order').get(order.id, MASTER);
    const name = latest.get('cashierName');
    throw forbidden(
      name
        ? `${name} just took this order. Ask them to transfer it to you`
        : 'Another cashier is taking this order. Refresh and try again',
    );
  }
  const me = await actor.fetch(MASTER);
  order.set({ cashier: me, cashierName: personName(me), assignedAt: new Date() });
}

// A file's public URL. With direct access and no publicServerURL, Parse
// Server can build "undefined/files/…"; fall back to the server URL.
function fileUrl(file) {
  const url = file?.url?.() || null;
  if (!url || /^https?:\/\//.test(url)) return url;
  const base = String(process.env.PARSE_PUBLIC_SERVER_URL || Parse.serverURL || '').replace(
    /\/$/,
    '',
  );
  return `${base}${url.replace(/^(undefined|null)/, '')}`;
}

// A code produced by the old bug ("…[object Object]") or otherwise not in the
// expected shape.
const isBrokenCode = (code) => typeof code === 'string' && /object|undefined|NaN/.test(code);

module.exports = {
  MASTER,
  clearSignInLock,
  findAll,
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
  nextSequence,
  claimOnce,
  verifyPin,
  takeOrder,
  withRiderLimit,
  endSessions,
  fileUrl,
  orNone,
};
