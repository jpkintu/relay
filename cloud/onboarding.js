// Getting a new restaurant ready (Admin → Get started): how far setup has
// got, the menu import from a spreadsheet, and marking setup finished.

const {
  MASTER,
  DEFAULT_CONFIG,
  adminOnly,
  audit,
  findAll,
  invalid,
  loadConfig,
  readAcl,
} = require('./lib/core');
const { SEED_MENU } = require('./lib/seed');
const { checkImportRows } = require('./lib/menuImport');

const STARTER_TITLES = new Set(SEED_MENU.map((entry) => entry.title.toLowerCase()));
const isStarter = (item) => STARTER_TITLES.has(String(item.get('title') || '').toLowerCase());

async function activeMembers(roleName) {
  const role = await new Parse.Query(Parse.Role).equalTo('name', roleName).first(MASTER);
  if (!role) return 0;
  const users = await findAll(role.getUsers().query());
  return users.filter((user) => user.get('active') !== false).length;
}

// Owner: what is done and what is left. The starter dishes created with the
// first owner do not count as the restaurant's menu.
Parse.Cloud.define('getSetupProgress', async (request) => {
  await adminOnly(request);
  const dishQuery = new Parse.Query('MenuItem');
  dishQuery.notEqualTo('active', false);
  const [{ values }, dishes, riders, cashiers] = await Promise.all([
    loadConfig(),
    findAll(dishQuery),
    activeMembers('rider'),
    activeMembers('cashier'),
  ]);
  const ownDishes = dishes.filter((item) => !isStarter(item)).length;
  const hasOrders = !!(await new Parse.Query('Order').first(MASTER));
  const steps = {
    details: values.restaurantName !== DEFAULT_CONFIG.restaurantName,
    logo: !!values.restaurantLogo,
    menu: ownDishes > 0,
    riders: riders > 0,
    cashiers: cashiers > 0,
  };
  // The logo is optional; the rest is needed to take orders.
  const complete = steps.details && steps.menu && steps.riders && steps.cashiers;
  return {
    steps,
    dishes: ownDishes,
    starterDishes: dishes.length - ownDishes,
    riders,
    cashiers,
    complete,
    // A restaurant already taking orders is not asked to "get started" unless
    // the owner reopens it.
    finished: values.setupDone === true || (values.setupDone !== false && complete && hasOrders),
  };
});

// Owner: add dishes from a spreadsheet. { rows: [{ title, price, category,
// description, prepMinutes }], updateExisting, removeStarter, dryRun }.
// Nothing is saved if any row has a problem; dryRun only checks and counts.
// Dishes are matched to the menu by name: existing ones are left alone, or
// get the new price, category, description and prep time with updateExisting.
Parse.Cloud.define('adminImportMenu', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params || {};
  const { rows, errors } = checkImportRows(p.rows);
  const [menu, categories] = await Promise.all([
    findAll(new Parse.Query('MenuItem')),
    findAll(new Parse.Query('MenuCategory')),
  ]);
  const current = menu.filter((item) => !item.get('archivedAt'));
  const byTitle = new Map(current.map((item) => [item.get('title').toLowerCase(), item]));
  // Category names are matched ignoring case; a dish takes the exact spelling
  // of the category it lands in.
  const known = new Map(
    categories.map((row) => [row.get('title').toLowerCase(), row.get('title')]),
  );
  const starter = p.removeStarter
    ? current.filter(
        (item) =>
          isStarter(item) &&
          !rows.some((row) => row.title.toLowerCase() === item.get('title').toLowerCase()),
      )
    : [];
  // With no categories set up yet, the categories dishes already use are
  // created too, so every dish keeps a valid one.
  const wanted = [
    ...(categories.length
      ? []
      : current.filter((item) => !starter.includes(item)).map((item) => item.get('category'))),
    ...rows.map((row) => row.category),
  ];
  const newCategories = [];
  for (const title of wanted.filter(Boolean)) {
    if (known.has(title.toLowerCase())) continue;
    known.set(title.toLowerCase(), title);
    newCategories.push(title);
  }
  for (const row of rows) row.category = known.get(row.category.toLowerCase()) || row.category;
  const create = rows.filter((row) => !byTitle.has(row.title.toLowerCase()));
  const existing = rows.filter((row) => byTitle.has(row.title.toLowerCase()));
  const summary = {
    created: create.length,
    updated: p.updateExisting ? existing.length : 0,
    skipped: p.updateExisting ? 0 : existing.length,
    categoriesCreated: newCategories,
    starterRemoved: starter.length,
    errors,
  };
  if (p.dryRun) return summary;
  if (errors.length)
    throw invalid(
      `Row ${errors[0].row}: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`,
    );

  let categoryOrder = Math.max(0, ...categories.map((row) => Number(row.get('sortOrder') || 0)));
  const categoryRows = newCategories.map((title) => {
    const row = new Parse.Object('MenuCategory');
    categoryOrder += 1;
    row.set({ title, active: true, sortOrder: categoryOrder });
    row.setACL(readAcl(null, ['admin']));
    return row;
  });
  if (categoryRows.length) await Parse.Object.saveAll(categoryRows, MASTER);

  let dishOrder = Math.max(0, ...menu.map((item) => Number(item.get('sortOrder') || 0)));
  const changed = [];
  for (const row of create) {
    const item = new Parse.Object('MenuItem');
    dishOrder += 1;
    item.set({
      title: row.title,
      price: row.price,
      category: row.category,
      description: row.description,
      active: true,
      availableToday: true,
      sortOrder: dishOrder,
      ...(row.prepMinutes !== undefined && { prepMinutes: row.prepMinutes }),
    });
    item.setACL(readAcl(null, ['admin']));
    changed.push(item);
  }
  if (p.updateExisting)
    for (const row of existing) {
      const item = byTitle.get(row.title.toLowerCase());
      item.set({ price: row.price, category: row.category });
      if (row.description) item.set('description', row.description);
      if (row.prepMinutes !== undefined) item.set('prepMinutes', row.prepMinutes);
      changed.push(item);
    }
  // Starter dishes are archived, not deleted (the same as the Menu page).
  for (const item of starter) {
    item.set({ active: false, archivedAt: new Date() });
    changed.push(item);
  }
  if (changed.length) await Parse.Object.saveAll(changed, MASTER);
  await audit(actor, 'menu.imported', { className: 'MenuItem', id: 'import' }, null, {
    created: create.map((row) => row.title),
    updated: summary.updated ? existing.map((row) => row.title) : [],
    skipped: summary.skipped,
    categoriesCreated: newCategories,
    starterRemoved: starter.map((item) => item.get('title')),
  });
  return summary;
});

// Owner: setup finished (hides Get started), or reopened.
Parse.Cloud.define('adminFinishSetup', async (request) => {
  const actor = await adminOnly(request);
  const done = request.params?.done !== false;
  const { object } = await loadConfig();
  const config = object || new Parse.Object('Configuration');
  const before = { setupDone: config.get('setupDone') === true };
  config.set('setupDone', done);
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  await audit(actor, 'setup.finished', config, before, { setupDone: done });
  return { finished: done };
});
