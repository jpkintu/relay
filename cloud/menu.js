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
const { servableAccompaniments } = require('./orders');

// What a rider can order right now. Accompaniment groups only list
// accompaniments that are active and not sold out.
Parse.Cloud.define('getOperationalMenu', async (request) => {
  await requireRole(request, ['rider', 'cashier', 'admin']);
  const query = new Parse.Query('MenuItem');
  query.equalTo('active', true);
  query.equalTo('availableToday', true);
  query.ascending('sortOrder');
  query.limit(500);
  const categoryQuery = new Parse.Query('MenuCategory');
  const [menu, accompaniments, { values: config }, categoryRows] = await Promise.all([
    query.find(MASTER),
    servableAccompaniments(),
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
});

// Everything staff can switch on or off during service.
Parse.Cloud.define('getStock', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
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
    items: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      category: item.get('category') || 'Mains',
      available: item.get('availableToday') !== false,
    })),
    accompaniments: accompaniments.map((row) => ({
      id: row.id,
      title: row.get('title'),
      available: row.get('available') !== false,
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
  const field = type === 'menuItem' ? 'availableToday' : 'available';
  const row = await new Parse.Query(className).get(String(id), MASTER);
  const before = { [field]: row.get(field) };
  row.set(field, available);
  await row.save(null, MASTER);
  await audit(actor, `stock.${available ? 'available' : 'sold_out'}`, row, before, {
    [field]: available,
  });
  return { id: row.id, available };
});
