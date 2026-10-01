// Menu for order entry, and day-to-day availability ("86ing") for staff.

const {
  MASTER,
  invalid,
  requireRole,
  audit,
  loadConfig,
  requireCashierShift,
  fileUrl,
  findAll,
} = require('./lib/core');
const { availableGroups } = require('./lib/accompaniments');
const { servableAccompaniments, offeredAt, inStockAt } = require('./orders');
const { branchFor, branchParam } = require('./branches');

// The branch a menu or stock request is about: the caller's own, or the one
// the owner picks (none: every branch, as it was before branches).
async function branchOfRequest(user, role, id) {
  if (role === 'admin') return id ? branchParam(id) : null;
  return branchFor(user);
}

// What can be ordered right now at a branch (the online menu too).
// Accompaniment groups only list accompaniments that are active and not
// sold out.
async function operationalMenu(branchId) {
  const query = new Parse.Query('MenuItem');
  query.equalTo('active', true);
  query.equalTo('availableToday', true);
  query.ascending('sortOrder');
  query.limit(500);
  const categoryQuery = new Parse.Query('MenuCategory');
  const [menu, accompaniments, { values: config }, categoryRows] = await Promise.all([
    query.find(MASTER),
    servableAccompaniments(branchId),
    loadConfig(),
    findAll(categoryQuery),
  ]);
  // Hidden categories take their dishes off the menu; tabs follow the owner's order.
  const hidden = new Set(
    categoryRows.filter((row) => row.get('active') === false).map((row) => row.get('title')),
  );
  const categories = categoryRows
    .filter((row) => row.get('active') !== false)
    .sort((a, b) => Number(a.get('sortOrder') || 0) - Number(b.get('sortOrder') || 0))
    .map((row) => row.get('title'));
  return {
    categories,
    items: menu
      .filter((item) => !hidden.has(item.get('category') || 'Mains'))
      .filter((item) => offeredAt(item, branchId) && inStockAt(item, branchId))
      .map((item) => ({
        id: item.id,
        title: item.get('title'),
        category: item.get('category') || 'Mains',
        price: item.get('price'),
        description: item.get('description') || '',
        image: fileUrl(item.get('image')),
        prepMinutes: Number(item.get('prepMinutes') || 0),
        accompanimentGroups: availableGroups(item.get('accompanimentGroups') || [], (id) =>
          accompaniments.has(id),
        ).map((group) => ({
          ...group,
          options: group.options.map((id) => ({
            id,
            title: accompaniments.get(id).get('title'),
            price: Number(accompaniments.get(id).get('price') || 0),
          })),
        })),
      })),
    deliveryFee: config.defaultDeliveryFee,
    currencySymbol: config.currencySymbol,
  };
}

// What a rider can order right now.
Parse.Cloud.define('getOperationalMenu', async (request) => {
  const { user, role } = await requireRole(request, ['rider', 'cashier', 'admin']);
  // The owner orders for the main branch unless they pick one (as
  // createCounterOrder does).
  const branchId = (
    role === 'admin' && request.params.branchId
      ? await branchParam(request.params.branchId)
      : await branchFor(user)
  )?.id;
  return operationalMenu(branchId);
});

// Everything staff can switch on or off during service.
// Per branch: a cashier sees their own branch; the owner picks one (or
// none: sold out everywhere). Dishes the branch does not offer are left out.
Parse.Cloud.define('getStock', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  const branch = await branchOfRequest(user, role, request.params.branchId);
  const branchId = branch?.id;
  const items = new Parse.Query('MenuItem');
  items.equalTo('active', true);
  items.ascending('sortOrder');
  items.limit(500);
  const extras = new Parse.Query('Accompaniment');
  extras.equalTo('active', true);
  extras.ascending('sortOrder');
  extras.limit(500);
  const [menu, accompaniments] = await Promise.all([items.find(MASTER), extras.find(MASTER)]);
  return {
    branch: branch ? { id: branch.id, name: branch.get('name') } : null,
    items: menu
      .filter((item) => offeredAt(item, branchId))
      .map((item) => ({
        id: item.id,
        title: item.get('title'),
        category: item.get('category') || 'Mains',
        available: item.get('availableToday') !== false && inStockAt(item, branchId),
        // Sold out at every branch (only the owner changes that).
        everywhere: item.get('availableToday') === false,
      })),
    accompaniments: accompaniments.map((row) => ({
      id: row.id,
      title: row.get('title'),
      available: row.get('available') !== false && inStockAt(row, branchId),
      everywhere: row.get('available') === false,
      price: Number(row.get('price') || 0),
    })),
  };
});

// Mark a dish or an accompaniment as sold out / available again.
Parse.Cloud.define('setAvailability', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  const { type, id } = request.params;
  const available = request.params.available === true;
  const className = { menuItem: 'MenuItem', accompaniment: 'Accompaniment' }[type];
  if (!className) throw invalid('Unknown item type');
  const row = await new Parse.Query(className).get(String(id), MASTER);
  // At one branch: the cashier's own, or the one the owner picked. Without
  // branches (or the owner choosing none): everywhere.
  const branch = await branchOfRequest(actor, role, request.params.branchId);
  if (branch) {
    const soldOut = new Set(row.get('soldOutAt') || []);
    const before = { soldOutAt: [...soldOut] };
    if (available) soldOut.delete(branch.id);
    else soldOut.add(branch.id);
    row.set('soldOutAt', [...soldOut]);
    await row.save(null, MASTER);
    await audit(actor, `stock.${available ? 'available' : 'sold_out'}`, row, before, {
      branch: branch.get('name'),
      soldOutAt: [...soldOut],
    });
    return { id: row.id, available, branchId: branch.id };
  }
  const field = type === 'menuItem' ? 'availableToday' : 'available';
  const before = { [field]: row.get(field) };
  row.set(field, available);
  await row.save(null, MASTER);
  await audit(actor, `stock.${available ? 'available' : 'sold_out'}`, row, before, {
    [field]: available,
  });
  return { id: row.id, available };
});

module.exports = { operationalMenu };
