// Menu for order entry, and day-to-day availability ("86ing") for staff.

const { MASTER, invalid, requireRole, audit, loadConfig } = require('./lib/core');
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
  const [menu, accompaniments, { values: config }] = await Promise.all([
    query.find(MASTER),
    servableAccompaniments(),
    loadConfig(),
  ]);
  return {
    items: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      category: item.get('category') || 'Mains',
      price: item.get('price'),
      accompanimentGroups: availableGroups(item.get('accompanimentGroups') || [], (id) =>
        accompaniments.has(id),
      ).map((group) => ({
        ...group,
        options: group.options.map((id) => ({ id, title: accompaniments.get(id).get('title') })),
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
    })),
  };
});

// Mark a dish or an accompaniment as sold out / available again.
Parse.Cloud.define('setAvailability', async (request) => {
  const { user: actor } = await requireRole(request, ['cashier', 'admin']);
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
