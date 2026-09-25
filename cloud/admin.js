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
} = require('./lib/core');
const { COMMISSION_TYPES } = require('./lib/money');
const { isValidTimeZone } = require('./lib/dates');
const { SEED_MENU } = require('./lib/seed');
const { applySecurity } = require('./security');

const ROLE_NAMES = ['admin', 'cashier', 'rider'];
const STAFF_ROLES = ['rider', 'cashier'];
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
  const [users, menu, categories, members, { object: config, values }] = await Promise.all([
    userQuery.find(MASTER),
    menuQuery.find(MASTER),
    categoryQuery.find(MASTER),
    roleMembership(),
    loadConfig(),
  ]);
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
    })),
    menu: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      price: item.get('price'),
      category: item.get('category'),
      active: item.get('active') !== false,
      availableToday: item.get('availableToday') !== false,
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
  const user = new Parse.User();
  user.set({
    username,
    password: pin,
    name,
    phone: String(p.phone || ''),
    active: true,
    commissionType: 'per_order',
    commissionPerOrder: 0,
    commissionPercent: 0,
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
    active: user.get('active'),
    commissionType: user.get('commissionType'),
    commissionPerOrder: user.get('commissionPerOrder'),
    commissionPercent: user.get('commissionPercent'),
  });
  const before = snapshot();
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
  item.setACL(readAcl(null, ['admin']));
  await item.save(null, MASTER);
  await audit(actor, 'menu.saved', item, before, { title, price });
  return { id: item.id };
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
  });
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  await audit(actor, 'configuration.saved', config, before, config.toJSON());
  return { id: config.id };
});

module.exports = { canBootstrapOwner };
