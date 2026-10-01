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
  nextStaffCode,
  endSessions,
  fileUrl,
  findAll,
} = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');
const { COMMISSION_TYPES, ROUNDING_STEPS } = require('./lib/money');
const { isValidTimeZone } = require('./lib/dates');
const { SEED_MENU } = require('./lib/seed');
const { normalizeGroups } = require('./lib/accompaniments');
const { applySecurity } = require('./security');
const { cleanLocation } = require('./lib/geo');
const { cleanTheme, themeProblems } = require('./lib/theme');

const ROLE_NAMES = ['admin', 'finance', 'cashier', 'rider'];
const STAFF_ROLES = ['rider', 'cashier', 'finance'];
const merchantField = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const codeField = (role) =>
  role === 'rider' ? 'riderCode' : role === 'finance' ? 'financeCode' : 'cashierCode';

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
  // Relay Hosted: restaurants start from the sign-up page (signUpRestaurant).
  requireUser(request);
  throw forbidden('Start a restaurant from the sign-up page');
});

// Recovery for a restaurant where nobody can sign in as owner (lost password,
// or accounts already existed so the in-app owner sign-up is closed).
// Creates the account, or resets its password if the username exists, and
// makes it an owner. Master key only: run it from the Back4App dashboard as
// the Cloud Job "createOwner" or via the REST console / curl with the master
// key. Params: { username, password, email?, name? }.
async function createOrResetOwner(params) {
  // Relay Hosted: for one restaurant, named by { restaurant: '<code>' }.
  const tenancy = require('./lib/tenant');
  if (!tenancy.current()) throw invalid('Give the restaurant code as "restaurant"');
  const username = tenancy.fullUsername(
    String(params.username || '')
      .trim()
      .toLowerCase(),
  );
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
    user.set('name', String(params.name || tenancy.displayUsername(username)).trim());
    await user.signUp(null, MASTER);
  } else {
    user.set({ password, active: true });
    await user.save(null, MASTER);
  }
  user.setACL(userAcl(user, 'admin'));
  await user.save(null, MASTER);
  await makeOwner(user, user);
  return { username: user.getUsername(), created, role: 'admin' };
}

Parse.Cloud.define('recoverOwner', async (request) => {
  if (!request.master) throw forbidden('Master key required');
  return createOrResetOwner(request.params);
});

Parse.Cloud.job('createOwner', async (request) => {
  const tenancy = require('./lib/tenant');
  const restaurant = await tenancy.restaurantFor({ params: request.params });
  const result = await tenancy.runAs(
    restaurant?.id,
    () => createOrResetOwner(request.params || {}),
    restaurant?.code,
  );
  return `Owner ${result.created ? 'created' : 'password reset'}: ${result.username}`;
});

async function roleMembership() {
  const query = new Parse.Query(Parse.Role);
  query.containedIn('name', ROLE_NAMES);
  const held = {};
  for (const role of await query.find(MASTER)) {
    const users = await findAll(role.getUsers().query());
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
  const shiftQuery = new Parse.Query('Shift');
  shiftQuery.equalTo('status', 'open');
  shiftQuery.select('operator');
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
    findAll(userQuery).then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt)),
    menuQuery.find(MASTER),
    categoryQuery.find(MASTER),
    roleMembership(),
    loadConfig(),
    accompanimentQuery.find(MASTER),
    findAll(cashQuery),
    findAll(shiftQuery),
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
      code: user.get('riderCode') || user.get('cashierCode') || user.get('financeCode') || '',
      commissionType: user.get('commissionType') || 'per_order',
      commissionPerOrder: user.get('commissionPerOrder') || 0,
      commissionPercent: user.get('commissionPercent') || 0,
      available: members[user.id] === 'rider' ? user.get('available') !== false : null,
      onShift: onShift.has(user.id),
      cashHeld: cashHeld[user.id] || 0,
      cashLimit: typeof user.get('maxFloat') === 'number' ? user.get('maxFloat') : null,
      branchId: user.get('branch')?.id || '',
    })),
    menu: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      price: item.get('price'),
      category: item.get('category'),
      active: item.get('active') !== false,
      availableToday: item.get('availableToday') !== false,
      branchIds: item.get('branchIds') || [],
      soldOutAt: item.get('soldOutAt') || [],
      accompanimentGroups: item.get('accompanimentGroups') || [],
      description: item.get('description') || '',
      image: fileUrl(item.get('image')),
      sortOrder: Number(item.get('sortOrder') || 0),
      prepMinutes: Number(item.get('prepMinutes') || 0),
      archived: !!item.get('archivedAt'),
    })),
    accompaniments: accompaniments.map((row) => ({
      id: row.id,
      title: row.get('title'),
      active: row.get('active') !== false,
      available: row.get('available') !== false,
      price: Number(row.get('price') || 0),
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
  await require('./lib/limits').checkMemberLimit(roleName);
  // Riders and cashiers work at one branch (the main one unless chosen);
  // finance sees every branch. Only once the restaurant has branches.
  const branches = require('./branches');
  const branch =
    roleName !== 'finance' && (p.branchId || (await branches.mainBranch()))
      ? await branches.assignableBranch(p.branchId, actor)
      : null;
  const user = new Parse.User();
  if (branch) user.set('branch', branch);
  user.set({
    // Relay Hosted: unique per restaurant (name@restaurant-code).
    username: require('./lib/tenant').fullUsername(username),
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
    branchId: user.get('branch')?.id || '',
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
  if (p.branchId !== undefined) {
    const branch = await require('./branches').assignableBranch(p.branchId, actor);
    user.set('branch', branch);
  }
  if (p.active === true && user.get('active') === false) {
    const role = await require('./lib/core').getRoleName(user);
    if (role && role !== 'admin') await require('./lib/limits').checkMemberLimit(role);
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
  if (!STAFF_ROLES.includes(next))
    throw invalid('Only rider, cashier and finance roles can be assigned');
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
  await require('./lib/limits').checkMemberLimit(next);
  const destination = await ensureRole(next);
  destination.getUsers().add(user);
  await destination.save(null, MASTER);
  if (!user.get(codeField(next))) user.set(codeField(next), await nextStaffCode(next));
  user.setACL(userAcl(user, next));
  await user.save(null, MASTER);
  await audit(actor, 'team.role_changed', user, { role: before }, { role: next });
  return { role: next };
});

// Owner: add, rename or hide a menu category. Renaming moves every dish in
// it to the new name; a hidden category's dishes are not offered for orders.
Parse.Cloud.define('adminSaveCategory', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const title = String(p.title || '').trim();
  if (!title || title.length > 80) throw invalid('Category title is required');
  const all = await findAll(new Parse.Query('MenuCategory'));
  if (all.some((row) => row.id !== p.id && row.get('title').toLowerCase() === title.toLowerCase()))
    throw invalid(`There is already a category called "${title}"`);
  const category = p.id ? all.find((row) => row.id === p.id) : new Parse.Object('MenuCategory');
  if (!category) throw invalid('Unknown category');
  const before = p.id ? category.toJSON() : null;
  const oldTitle = category.get('title');
  // New categories go to the end; saving keeps the position unless one is sent.
  const sortOrder =
    p.sortOrder !== undefined
      ? Number(p.sortOrder) || 0
      : p.id
        ? Number(category.get('sortOrder') || 0)
        : Math.max(0, ...all.map((row) => Number(row.get('sortOrder') || 0))) + 1;
  category.set({ title, active: p.active !== false, sortOrder });
  category.setACL(readAcl(null, ['admin']));
  await category.save(null, MASTER);
  let moved = 0;
  if (oldTitle && oldTitle !== title) {
    const dishes = await findAll(new Parse.Query('MenuItem').equalTo('category', oldTitle));
    dishes.forEach((dish) => dish.set('category', title));
    if (dishes.length) await Parse.Object.saveAll(dishes, MASTER);
    moved = dishes.length;
  }
  await audit(actor, 'menu.category_saved', category, before, {
    title,
    active: category.get('active'),
    ...(moved && { dishesMoved: moved }),
  });
  return { id: category.id, dishesMoved: moved };
});

// Owner: the categories in their new order (the order-taking tabs follow it).
Parse.Cloud.define('adminSortCategories', async (request) => {
  const actor = await adminOnly(request);
  const ids = Array.isArray(request.params.ids) ? request.params.ids.map(String) : [];
  if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length)
    throw invalid('Send the categories in their new order');
  const rows = await findAll(new Parse.Query('MenuCategory').containedIn('objectId', ids));
  if (rows.length !== ids.length) throw invalid('Unknown category in the list');
  for (const row of rows) row.set('sortOrder', ids.indexOf(row.id) + 1);
  await Parse.Object.saveAll(rows, MASTER);
  await audit(actor, 'menu.categories_sorted', rows[0], null, { count: rows.length });
  return { ok: true };
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
  const category = String(p.category || 'Mains').trim();
  // With categories set up, a dish must use one of them.
  const categories = await findAll(new Parse.Query('MenuCategory'));
  if (categories.length && !categories.some((row) => row.get('title') === category))
    throw invalid(`Choose one of the menu categories (not "${category}")`);
  const prep =
    p.prepMinutes === undefined || p.prepMinutes === null || p.prepMinutes === ''
      ? undefined
      : Number(p.prepMinutes);
  if (prep !== undefined && (!Number.isInteger(prep) || prep < 0 || prep > 240))
    throw invalid('Prep time must be whole minutes, 0 to 240');
  item.set({
    title,
    price,
    category,
    active: p.active !== false,
    availableToday: p.availableToday !== false,
    ...(prep !== undefined && { prepMinutes: prep }),
  });
  if (p.description !== undefined) item.set('description', merchantField(p.description, 300));
  // Branches that offer it (empty: every branch).
  if (p.branchIds !== undefined) {
    const wanted = Array.isArray(p.branchIds) ? [...new Set(p.branchIds.map(String))] : [];
    const known = new Set((await findAll(new Parse.Query('Branch'))).map((row) => row.id));
    if (wanted.some((id) => !known.has(id))) throw invalid('Unknown branch');
    item.set('branchIds', wanted);
  }
  // A new dish goes to the end of the menu.
  if (!p.id && item.get('sortOrder') === undefined) {
    const last = await new Parse.Query('MenuItem').descending('sortOrder').first(MASTER);
    item.set('sortOrder', (Number(last?.get('sortOrder')) || 0) + 1);
  }
  // Archived dishes leave the menu and the owner's list but keep their
  // history (order lines keep their own name and price).
  if (p.archived === true) item.set({ active: false, archivedAt: new Date() });
  if (p.archived === false) {
    item.set('active', true);
    if (item.has('archivedAt')) item.unset('archivedAt');
  }
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
  await audit(actor, p.archived === true ? 'menu.archived' : 'menu.saved', item, before, {
    title,
    price,
    description: item.get('description') || '',
    active: item.get('active'),
  });
  return { id: item.id };
});

// Owner: the order dishes appear in. { ids } lists dishes top to bottom.
Parse.Cloud.define('adminSortMenu', async (request) => {
  const actor = await adminOnly(request);
  const ids = Array.isArray(request.params.ids) ? request.params.ids.map(String) : [];
  if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
    throw invalid('Send the dishes in their new order');
  const query = new Parse.Query('MenuItem');
  query.containedIn('objectId', ids);
  query.limit(ids.length);
  const items = await query.find(MASTER);
  if (items.length !== ids.length) throw invalid('Unknown dish in the list');
  for (const item of items) item.set('sortOrder', ids.indexOf(item.id) + 1);
  await Parse.Object.saveAll(items, MASTER);
  await audit(actor, 'menu.sorted', items[0], null, { count: items.length });
  return { ok: true };
});

// Owner: a dish photo. { id, image: base64 JPEG/PNG/WebP (the app shrinks it
// first) } or { id, remove: true }.
const IMAGE_TYPES = { '/9j/': 'image/jpeg', iVBOR: 'image/png', UklGR: 'image/webp' };
const MAX_IMAGE_BASE64 = 700000; // about 500 KB
// A Parse.File from an uploaded base64 image, checked for type and size.
async function imageFile(base64, name) {
  const data = String(base64 || '').replace(/^data:[^,]+,/, '');
  const type = Object.entries(IMAGE_TYPES).find(([prefix]) => data.startsWith(prefix))?.[1];
  if (!type) throw invalid('Use a JPEG, PNG or WebP photo');
  if (data.length > MAX_IMAGE_BASE64) throw invalid('The photo is too large (500 KB at most)');
  const extension = type.split('/')[1].replace('jpeg', 'jpg');
  const file = new Parse.File(`${name}.${extension}`, { base64: data }, type);
  await file.save(MASTER);
  return file;
}

Parse.Cloud.define('adminSetMenuImage', async (request) => {
  const actor = await adminOnly(request);
  const item = await new Parse.Query('MenuItem').get(String(request.params.id || ''), MASTER);
  const before = { image: fileUrl(item.get('image')) };
  if (request.params.remove === true) {
    if (item.has('image')) item.unset('image');
  } else item.set('image', await imageFile(request.params.image, 'dish'));
  await item.save(null, MASTER);
  await audit(actor, 'menu.image', item, before, { image: fileUrl(item.get('image')) });
  return { image: fileUrl(item.get('image')) };
});

// Owner: the restaurant's logo, shown on the sign-in screen, the admin menu
// and printed receipts. { image: base64 PNG/JPEG/WebP } or { remove: true }.
Parse.Cloud.define('adminSetRestaurantLogo', async (request) => {
  const actor = await requireAdminUnlock(request);
  let { object: config } = await loadConfig();
  if (!config) {
    config = new Parse.Object('Configuration');
    config.setACL(readAcl(null, ['admin']));
  }
  const before = { logo: fileUrl(config.get('restaurantLogo')) };
  if (request.params.remove === true) {
    if (config.has('restaurantLogo')) config.unset('restaurantLogo');
  } else config.set('restaurantLogo', await imageFile(request.params.image, 'logo'));
  await config.save(null, MASTER);
  const logo = fileUrl(config.get('restaurantLogo'));
  await audit(actor, 'configuration.logo', config, before, { logo });
  return { logo: logo || '' };
});

// Owner: the pictures beside the sign-in form (Admin → Branding), shown in
// turn under a wash of the restaurant's colour. Up to 6. { add: base64
// image, caption? } | { remove: index } | { caption, index } | { move: index,
// to: index } → { images: [{ url, caption }] }
const MAX_LOGIN_IMAGES = 6;
Parse.Cloud.define('adminSetLoginImages', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  let { object: config } = await loadConfig();
  if (!config) {
    config = new Parse.Object('Configuration');
    config.setACL(readAcl(null, ['admin']));
  }
  const images = [...(config.get('loginImages') || [])];
  const index = Number(p.index ?? p.remove ?? p.move);
  const at = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= images.length) throw invalid('No such picture');
    return i;
  };
  const caption = (text) =>
    String(text || '')
      .trim()
      .slice(0, 80);
  if (p.add !== undefined) {
    if (images.length >= MAX_LOGIN_IMAGES)
      throw invalid(`At most ${MAX_LOGIN_IMAGES} pictures; remove one first`);
    images.push({ file: await imageFile(p.add, 'signin'), caption: caption(p.caption) });
  } else if (p.remove !== undefined) images.splice(at(index), 1);
  else if (p.move !== undefined) {
    const [picked] = images.splice(at(index), 1);
    images.splice(Math.max(0, Math.min(images.length, Number(p.to) || 0)), 0, picked);
  } else if (p.caption !== undefined)
    images[at(index)] = { ...images[at(index)], caption: caption(p.caption) };
  else throw invalid('Nothing to change');
  config.set('loginImages', images);
  await config.save(null, MASTER);
  const saved = images.map((entry) => ({
    url: fileUrl(entry.file) || '',
    caption: entry.caption || '',
  }));
  await audit(actor, 'configuration.login_images', config, null, { count: saved.length });
  return { images: saved };
});

// Accompaniments are free sides (matooke, rice, ...) attached to dishes in
// groups. `available` is the day-to-day sold-out switch cashiers also use.
Parse.Cloud.define('adminSaveAccompaniment', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const title = String(p.title || '').trim();
  if (!title || title.length > 60) throw invalid('An accompaniment name is required');
  // Free (price 0) or charged extra: the price is added to the dish's line.
  const price = p.price === undefined || p.price === null || p.price === '' ? 0 : Number(p.price);
  if (!Number.isInteger(price) || price < 0 || price > 1000000)
    throw invalid('An accompaniment price must be a whole amount from 0');
  const row = p.id
    ? await new Parse.Query('Accompaniment').get(p.id, MASTER)
    : new Parse.Object('Accompaniment');
  const before = p.id ? row.toJSON() : null;
  row.set({
    title,
    active: p.active !== false,
    available: p.available !== false,
    sortOrder: Number(p.sortOrder) || 0,
    price,
  });
  row.setACL(readAcl(null, ['admin']));
  await row.save(null, MASTER);
  await audit(actor, 'menu.accompaniment_saved', row, before, {
    title,
    active: row.get('active'),
    available: row.get('available'),
    price,
  });
  return { id: row.id };
});

// Owner: theme colours (Branding). { ink, accent } as #rrggbb; '' restores
// Relay's colour. Refused when text would be hard to read.
Parse.Cloud.define('adminSaveBranding', async (request) => {
  const actor = await requireAdminUnlock(request);
  const theme = cleanTheme(request.params);
  const problems = themeProblems(theme);
  if (problems.length) throw invalid(problems[0]);
  let { object: config } = await loadConfig();
  if (!config) {
    config = new Parse.Object('Configuration');
    config.setACL(readAcl(null, ['admin']));
  }
  const before = { ink: config.get('themeInk') || '', accent: config.get('themeAccent') || '' };
  config.set({ themeInk: theme.ink, themeAccent: theme.accent });
  await config.save(null, MASTER);
  await audit(actor, 'configuration.branding', config, before, theme);
  return theme;
});

Parse.Cloud.define('adminSaveSettings', async (request) => {
  const actor = await requireAdminUnlock(request);
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
  const place = cleanLocation(
    p.restaurantLat !== undefined || p.restaurantLng !== undefined
      ? { lat: p.restaurantLat, lng: p.restaurantLng }
      : { lat: current.restaurantLat, lng: current.restaurantLng },
  );
  if (place.error) throw invalid(`Restaurant location: ${place.error}`);
  const zHour = Number(p.zReportHour ?? current.zReportHour);
  if (!Number.isInteger(zHour) || zHour < 0 || zHour > 23)
    throw invalid('Z-report hour must be 0-23');
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
  const modules = [
    (p.moduleRiderOrders ?? current.moduleRiderOrders) !== false,
    (p.moduleCallIn ?? current.moduleCallIn) === true,
    (p.moduleCounter ?? current.moduleCounter) === true,
  ];
  if (!modules.some(Boolean)) throw invalid('Keep at least one way of taking orders switched on');
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
    cardEnabled: (p.cardEnabled ?? current.cardEnabled) === true,
    cardLabel: merchantField(p.cardLabel ?? current.cardLabel, 40),
    cardTerminalId: merchantField(p.cardTerminalId ?? current.cardTerminalId, 30),
    cardMerchantName: merchantField(p.cardMerchantName ?? current.cardMerchantName, 60),
    cashReminderHour: reminderHour,
    floatWarningPercent: warnPercent,
    commissionRounding: rounding,
    defaultCommissionType: commissionType,
    defaultCommissionPerOrder: perOrder,
    defaultCommissionPercent: percent,
    zReportHour: zHour,
    restaurantLat: place.location.lat,
    restaurantLng: place.location.lng,
    moduleRiderOrders: (p.moduleRiderOrders ?? current.moduleRiderOrders) !== false,
    moduleCallIn: (p.moduleCallIn ?? current.moduleCallIn) === true,
    moduleCounter: (p.moduleCounter ?? current.moduleCounter) === true,
    receiptWidth: Number(p.receiptWidth ?? current.receiptWidth) === 58 ? 58 : 80,
    receiptHeader: merchantField(p.receiptHeader ?? current.receiptHeader, 300),
    receiptFooter: merchantField(p.receiptFooter ?? current.receiptFooter, 200),
    autoPrintKitchen: (p.autoPrintKitchen ?? current.autoPrintKitchen) === true,
    cashDrawer: (p.cashDrawer ?? current.cashDrawer) === true,
    drawerOnSale: (p.drawerOnSale ?? current.drawerOnSale) !== false,
    drawerOnHandover: (p.drawerOnHandover ?? current.drawerOnHandover) !== false,
    drawerOnPayout: (p.drawerOnPayout ?? current.drawerOnPayout) !== false,
    drawerOnShift: (p.drawerOnShift ?? current.drawerOnShift) !== false,
  });
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  await audit(actor, 'configuration.saved', config, before, config.toJSON());
  return { id: config.id };
});

module.exports = { makeOwner };
