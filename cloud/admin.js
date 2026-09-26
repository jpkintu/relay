const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  adminOnly,
  ensureRole,
  readAcl,
  userAcl,
  audit,
  loadConfig,
  countUsers,
  nextStaffCode,
  endSessions,
} = require('./lib/core');
const { COMMISSION_TYPES, ROUNDING_STEPS } = require('./lib/money');
const { isValidTimeZone } = require('./lib/dates');
const { SEED_MENU } = require('./lib/seed');
const { normalizeGroups } = require('./lib/accompaniments');
const { applySecurity } = require('./security');

const ROLE_NAMES = ['admin', 'cashier', 'rider'];
const STAFF_ROLES = ['rider', 'cashier'];
const merchantField = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const codeField = (role) => (role === 'rider' ? 'riderCode' : 'cashierCode');

async function adminRoleExists() {
  const query = new Parse.Query(Parse.Role);
  query.equalTo('name', 'admin');
  return !!(await query.first(MASTER));
}

// First-owner setup is open only while no admin exists and the caller is the
// only account in the database.
async function canBootstrapOwner() {
  return !(await adminRoleExists()) && (await countUsers()) === 1;
}

// Makes `user` an owner (admin), creates the staff roles, seeds a starter menu
// on an empty restaurant and applies the security rules.
async function makeOwner(user, actor) {
  const role = await ensureRole('admin');
  role.getUsers().add(user);
  await role.save(null, MASTER);
  await Promise.all(STAFF_ROLES.map(ensureRole));
  if (!(await new Parse.Query('MenuItem').first(MASTER))) {
    const seed = SEED_MENU.map((entry, index) => {
      const item = new Parse.Object('MenuItem');
      item.set({
        title: entry.title,
        price: entry.price,
        category: entry.category,
        active: true,
        availableToday: true,
        sortOrder: index,
      });
      item.setACL(readAcl(null, ['admin']));
      return item;
    });
    await Parse.Object.saveAll(seed, MASTER);
  }
  await applySecurity();
  await audit(actor, 'owner.initialized', role, null, { userId: user.id });
}

Parse.Cloud.define('bootstrapOwner', async (request) => {
  const user = requireUser(request);
  if (await adminRoleExists()) throw forbidden('Owner already configured');
  if ((await countUsers()) !== 1)
    throw forbidden('Owner setup requires exactly one existing account');
  await makeOwner(user, user);
  return { ok: true };
});

// Recovery for a restaurant where nobody can sign in as owner (lost password,
// or accounts already existed so the in-app owner sign-up is closed).
// Creates the account, or resets its password if the username exists, and
// makes it an owner. Master key only: run it from the Back4App dashboard as
// the Cloud Job "createOwner" or via the REST console / curl with the master
// key. Params: { username, password, email?, name? }.
async function createOrResetOwner(params) {
  const username = String(params.username || '')
    .trim()
    .toLowerCase();
  const password = String(params.password || '');
  if (!/^[-a-z0-9_.@]{3,64}$/.test(username) || password.length < 8)
    throw invalid('Give a username (3+ characters) and a password of at least 8 characters');
  const query = new Parse.Query(Parse.User);
  query.equalTo('username', username);
  let user = await query.first(MASTER);
  const created = !user;
  if (!user) {
    user = new Parse.User();
    user.set({ username, password, active: true });
    if (params.email) user.set('email', String(params.email).trim());
    user.set('name', String(params.name || username).trim());
    await user.signUp(null, MASTER);
  } else {
    user.set({ password, active: true });
    await user.save(null, MASTER);
  }
  user.setACL(userAcl(user, 'admin'));
  await user.save(null, MASTER);
  await makeOwner(user, user);
  return { username, created, role: 'admin' };
}

Parse.Cloud.define('recoverOwner', async (request) => {
  if (!request.master) throw forbidden('Master key required');
  return createOrResetOwner(request.params);
});

Parse.Cloud.job('createOwner', async (request) => {
  const result = await createOrResetOwner(request.params || {});
  return `Owner ${result.created ? 'created' : 'password reset'}: ${result.username}`;
});

async function roleMembership() {
  const query = new Parse.Query(Parse.Role);
  query.containedIn('name', ROLE_NAMES);
  const held = {};
  for (const role of await query.find(MASTER)) {
    const users = await role.getUsers().query().limit(1000).find(MASTER);
    for (const user of users) (held[user.id] ||= []).push(role.getName());
  }
  // Report the highest-privilege role when someone holds several.
  const members = {};
  for (const [id, names] of Object.entries(held))
    members[id] = ROLE_NAMES.find((name) => names.includes(name));
  return members;
}

Parse.Cloud.define('adminListSetup', async (request) => {
  await adminOnly(request);
  const userQuery = new Parse.Query(Parse.User);
  userQuery.ascending('createdAt');
  userQuery.limit(1000);
  const menuQuery = new Parse.Query('MenuItem');
  menuQuery.ascending('sortOrder');
  menuQuery.limit(1000);
  const categoryQuery = new Parse.Query('MenuCategory');
  categoryQuery.ascending('sortOrder');
  categoryQuery.limit(1000);
  const accompanimentQuery = new Parse.Query('Accompaniment');
  accompanimentQuery.ascending('sortOrder');
  accompanimentQuery.limit(1000);
  // Cash each rider holds (delivered, not yet reconciled) and who is on shift.
  const cashQuery = new Parse.Query('Order');
  cashQuery.equalTo('status', 'DELIVERED');
  cashQuery.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  cashQuery.select('createdBy', 'amountCollected');
  cashQuery.limit(5000);
  const shiftQuery = new Parse.Query('Shift');
  shiftQuery.equalTo('status', 'open');
  shiftQuery.select('operator');
  shiftQuery.limit(1000);
  const [
    users,
    menu,
    categories,
    members,
    { object: config, values },
    accompaniments,
    cashOrders,
    openShifts,
  ] = await Promise.all([
    userQuery.find(MASTER),
    menuQuery.find(MASTER),
    categoryQuery.find(MASTER),
    roleMembership(),
    loadConfig(),
    accompanimentQuery.find(MASTER),
    cashQuery.find(MASTER),
    shiftQuery.find(MASTER),
  ]);
  const cashHeld = {};
  for (const order of cashOrders) {
    const id = order.get('createdBy')?.id;
    if (id) cashHeld[id] = (cashHeld[id] || 0) + (Number(order.get('amountCollected')) || 0);
  }
  const onShift = new Set(openShifts.map((row) => row.get('operator')?.id));
  return {
    team: users.map((user) => ({
      id: user.id,
      name: user.get('name') || user.getUsername(),
      username: user.getUsername(),
      phone: user.get('phone') || '',
      active: user.get('active') !== false,
      role: members[user.id] || 'unassigned',
      code: user.get('riderCode') || user.get('cashierCode') || '',
      commissionType: user.get('commissionType') || 'per_order',
      commissionPerOrder: user.get('commissionPerOrder') || 0,
      commissionPercent: user.get('commissionPercent') || 0,
      available: members[user.id] === 'rider' ? user.get('available') !== false : null,
      onShift: onShift.has(user.id),
      cashHeld: cashHeld[user.id] || 0,
      cashLimit: typeof user.get('maxFloat') === 'number' ? user.get('maxFloat') : null,
    })),
    menu: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      price: item.get('price'),
      category: item.get('category'),
      active: item.get('active') !== false,
      availableToday: item.get('availableToday') !== false,
      accompanimentGroups: item.get('accompanimentGroups') || [],
    })),
    accompaniments: accompaniments.map((row) => ({
      id: row.id,
      title: row.get('title'),
      active: row.get('active') !== false,
      available: row.get('available') !== false,
    })),
    categories: categories.map((category) => ({
      id: category.id,
      title: category.get('title'),
      active: category.get('active') !== false,
    })),
    settings: config ? { id: config.id, ...values } : null,
  };
});

Parse.Cloud.define('adminCreateTeamMember', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const roleName = p.role;
  if (!STAFF_ROLES.includes(roleName)) throw invalid('Invalid role');
  const name = String(p.name || '').trim();
  const username = String(p.username || '')
    .trim()
    .toLowerCase();
  const pin = String(p.pin || '');
  if (!name || !/^[-a-z0-9_.]{3,32}$/.test(username) || pin.length < 4 || pin.length > 32)
    throw invalid('Enter a name, valid username and PIN of at least 4 characters');
  const { values: config } = await loadConfig();
  const user = new Parse.User();
  user.set({
    username,
    password: pin,
    name,
    phone: String(p.phone || ''),
    active: true,
    commissionType: COMMISSION_TYPES.includes(config.defaultCommissionType)
      ? config.defaultCommissionType
      : 'per_order',
    commissionPerOrder: Number(config.defaultCommissionPerOrder) || 0,
    commissionPercent: Number(config.defaultCommissionPercent) || 0,
    [codeField(roleName)]: await nextStaffCode(roleName),
  });
  await user.signUp(null, MASTER);
  user.setACL(userAcl(user, roleName));
  await user.save(null, MASTER);
  const role = await ensureRole(roleName);
  role.getUsers().add(user);
  await role.save(null, MASTER);
  await audit(actor, 'team.created', user, null, { name, role: roleName });
  return { id: user.id, name, username, role: roleName, code: user.get(codeField(roleName)) };
});

Parse.Cloud.define('adminUpdateMember', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const user = await new Parse.Query(Parse.User).get(p.id, MASTER);
  if (user.id === actor.id && p.active === false) throw forbidden('You cannot deactivate yourself');
  const snapshot = () => ({
    name: user.get('name'),
    phone: user.get('phone'),
    active: user.get('active'),
    commissionType: user.get('commissionType'),
    commissionPerOrder: user.get('commissionPerOrder'),
    commissionPercent: user.get('commissionPercent'),
    maxFloat: user.get('maxFloat'),
  });
  const before = snapshot();
  if (p.name !== undefined) {
    const name = String(p.name || '').trim();
    if (!name || name.length > 80) throw invalid('Enter a name');
    user.set('name', name);
  }
  if (p.phone !== undefined)
    user.set(
      'phone',
      String(p.phone || '')
        .trim()
        .slice(0, 30),
    );
  // The rider's own cash limit; empty or null goes back to the restaurant's.
  if (p.maxFloat !== undefined) {
    if (p.maxFloat === null || p.maxFloat === '') {
      if (user.has('maxFloat')) user.unset('maxFloat');
    } else {
      const limit = Number(p.maxFloat);
      if (!Number.isFinite(limit) || limit < 0 || limit > 100000000)
        throw invalid('Invalid cash limit');
      user.set('maxFloat', Math.round(limit));
    }
  }
  const deactivating = p.active === false && user.get('active') !== false;
  if (typeof p.active === 'boolean') user.set('active', p.active);
  if (p.commissionType !== undefined) {
    if (!COMMISSION_TYPES.includes(p.commissionType)) throw invalid('Invalid commission type');
    user.set('commissionType', p.commissionType);
  }
  for (const key of ['commissionPerOrder', 'commissionPercent'])
    if (p[key] !== undefined) {
      const value = Number(p[key]);
      const max = key === 'commissionPercent' ? 100 : 1000000;
      if (!Number.isFinite(value) || value < 0 || value > max)
        throw invalid('Invalid commission value');
      user.set(key, value);
    }
  await user.save(null, MASTER);
  // A deactivated member is signed out of every device.
  if (deactivating) await endSessions(user);
  await audit(actor, 'team.updated', user, before, snapshot());
  return { ok: true };
});

Parse.Cloud.define('adminChangeRole', async (request) => {
  const actor = await adminOnly(request);
  const { userId, role: next } = request.params;
  if (!STAFF_ROLES.includes(next)) throw invalid('Only rider and cashier roles can be assigned');
  const user = await new Parse.Query(Parse.User).get(userId, MASTER);
  if (user.id === actor.id) throw forbidden('You cannot change your own role');
  const query = new Parse.Query(Parse.Role);
  query.containedIn('name', ROLE_NAMES);
  const roles = await query.find(MASTER);
  const isMember = (role) =>
    role
      .getUsers()
      .query()
      .get(userId, MASTER)
      .then(() => true)
      .catch(() => false);
  const adminRole = roles.find((role) => role.getName() === 'admin');
  if (adminRole && (await isMember(adminRole)))
    throw forbidden('Admin roles cannot be changed here');
  let before = 'unassigned';
  for (const role of roles.filter((r) => STAFF_ROLES.includes(r.getName()))) {
    if (await isMember(role)) {
      before = role.getName();
      role.getUsers().remove(user);
      await role.save(null, MASTER);
    }
  }
  const destination = await ensureRole(next);
  destination.getUsers().add(user);
  await destination.save(null, MASTER);
  if (!user.get(codeField(next))) user.set(codeField(next), await nextStaffCode(next));
  user.setACL(userAcl(user, next));
  await user.save(null, MASTER);
  await audit(actor, 'team.role_changed', user, { role: before }, { role: next });
  return { role: next };
});

Parse.Cloud.define('adminSaveCategory', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const title = String(p.title || '').trim();
  if (!title || title.length > 80) throw invalid('Category title is required');
  const category = p.id
    ? await new Parse.Query('MenuCategory').get(p.id, MASTER)
    : new Parse.Object('MenuCategory');
  const before = p.id ? category.toJSON() : null;
  category.set({ title, active: p.active !== false, sortOrder: Number(p.sortOrder) || 0 });
  category.setACL(readAcl(null, ['admin']));
  await category.save(null, MASTER);
  await audit(actor, 'menu.category_saved', category, before, {
    title,
    active: category.get('active'),
  });
  return { id: category.id };
});

Parse.Cloud.define('adminSaveMenuItem', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const item = p.id
    ? await new Parse.Query('MenuItem').get(p.id, MASTER)
    : new Parse.Object('MenuItem');
  const title = String(p.title || '').trim();
  const price = Number(p.price);
  if (!title || !Number.isFinite(price) || price < 0)
    throw invalid('A title and nonnegative price are required');
  const before = p.id ? item.toJSON() : null;
  item.set({
    title,
    price,
    category: String(p.category || 'Mains').trim(),
    active: p.active !== false,
    availableToday: p.availableToday !== false,
  });
  if (p.accompanimentGroups !== undefined) {
    const known = new Parse.Query('Accompaniment');
    known.limit(1000);
    const ids = new Set((await known.find(MASTER)).map((row) => row.id));
    try {
      item.set('accompanimentGroups', normalizeGroups(p.accompanimentGroups, ids));
    } catch (e) {
      throw invalid(e.message);
    }
  }
  item.setACL(readAcl(null, ['admin']));
  await item.save(null, MASTER);
  await audit(actor, 'menu.saved', item, before, { title, price });
  return { id: item.id };
});

// Accompaniments are free sides (matooke, rice, ...) attached to dishes in
// groups. `available` is the day-to-day sold-out switch cashiers also use.
Parse.Cloud.define('adminSaveAccompaniment', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const title = String(p.title || '').trim();
  if (!title || title.length > 60) throw invalid('An accompaniment name is required');
  const row = p.id
    ? await new Parse.Query('Accompaniment').get(p.id, MASTER)
    : new Parse.Object('Accompaniment');
  const before = p.id ? row.toJSON() : null;
  row.set({
    title,
    active: p.active !== false,
    available: p.available !== false,
    sortOrder: Number(p.sortOrder) || 0,
  });
  row.setACL(readAcl(null, ['admin']));
  await row.save(null, MASTER);
  await audit(actor, 'menu.accompaniment_saved', row, before, {
    title,
    active: row.get('active'),
    available: row.get('available'),
  });
  return { id: row.id };
});

Parse.Cloud.define('adminSaveSettings', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const { object: existing, values: current } = await loadConfig();
  const config = existing || new Parse.Object('Configuration');
  const before = existing ? existing.toJSON() : null;
  const fee = Number(p.defaultDeliveryFee);
  const max = Number(p.maxRiderFloat);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(max) || max < 0)
    throw invalid('Fee and float limit must be nonnegative');
  const timezone = String(p.timezone || current.timezone).trim();
  if (!isValidTimeZone(timezone)) throw invalid('Unknown timezone, e.g. Africa/Kampala');
  const reminderHour = Number(p.cashReminderHour ?? current.cashReminderHour);
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23)
    throw invalid('Cash reminder hour must be 0-23');
  const warnPercent = Number(p.floatWarningPercent ?? current.floatWarningPercent);
  if (!Number.isFinite(warnPercent) || warnPercent < 50 || warnPercent > 99)
    throw invalid('Cash warning must be between 50% and 99% of the limit');
  const rounding = String(p.commissionRounding ?? current.commissionRounding);
  if (!Object.hasOwn(ROUNDING_STEPS, rounding)) throw invalid('Invalid commission rounding');
  const commissionType = String(p.defaultCommissionType ?? current.defaultCommissionType);
  if (!COMMISSION_TYPES.includes(commissionType)) throw invalid('Invalid commission type');
  const perOrder = Number(p.defaultCommissionPerOrder ?? current.defaultCommissionPerOrder);
  const percent = Number(p.defaultCommissionPercent ?? current.defaultCommissionPercent);
  if (!Number.isFinite(perOrder) || perOrder < 0 || perOrder > 1000000)
    throw invalid('Invalid default commission amount');
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw invalid('Default commission percent must be 0-100');
  config.set({
    restaurantName: String(p.restaurantName || current.restaurantName).trim(),
    currencySymbol: String(p.currencySymbol || current.currencySymbol).trim(),
    currencyCode: String(p.currencyCode || current.currencyCode)
      .trim()
      .toUpperCase(),
    timezone,
    defaultDeliveryFee: fee,
    maxRiderFloat: max,
    allowBatching: !!p.allowBatching,
    requireCashierConfirmForPickup: !!p.requireCashierConfirmForPickup,
    airtelMerchantCode: merchantField(p.airtelMerchantCode, 30),
    airtelMerchantName: merchantField(p.airtelMerchantName, 60),
    mtnMerchantCode: merchantField(p.mtnMerchantCode, 30),
    mtnMerchantName: merchantField(p.mtnMerchantName, 60),
    cashReminderHour: reminderHour,
    floatWarningPercent: warnPercent,
    commissionRounding: rounding,
    defaultCommissionType: commissionType,
    defaultCommissionPerOrder: perOrder,
    defaultCommissionPercent: percent,
  });
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  await audit(actor, 'configuration.saved', config, before, config.toJSON());
  return { id: config.id };
});

module.exports = { canBootstrapOwner };
