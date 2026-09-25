// Optional demo mode for sales previews. Disabled unless the Cloud Code
// environment sets RELAY_ENABLE_PREVIEW=true. Demo rows live in DemoOrder and
// never touch operational data.

const { MASTER, forbidden, invalid } = require('./lib/core');
const { SEED_MENU } = require('./lib/seed');

const previewEnabled = () => process.env.RELAY_ENABLE_PREVIEW === 'true';
const DEMO_FEE = 3000;

function requirePreview() {
  if (!previewEnabled()) throw forbidden('Preview mode is disabled');
}

Parse.Cloud.define('createPreviewOrder', async (request) => {
  requirePreview();
  const p = request.params;
  if (!String(p.customerName || '').trim() || !String(p.deliveryAddress || '').trim())
    throw invalid('Customer and address are required');
  if (!Array.isArray(p.items) || !p.items.length) throw invalid('Add at least one item');
  let subtotal = 0;
  const itemSummary = p.items
    .map((line) => {
      const menu = SEED_MENU.find((item) => item.key === String(line.id));
      const qty = Number(line.quantity);
      if (!menu || !Number.isInteger(qty) || qty < 1 || qty > 50) throw invalid('Invalid item');
      subtotal += menu.price * qty;
      return `${qty}× ${menu.title}`;
    })
    .join(' · ');
  const row = new Parse.Object('DemoOrder');
  row.set({
    orderCode: `DEMO-${String(Date.now()).slice(-6)}`,
    customerName: String(p.customerName).trim().slice(0, 80),
    deliveryAddress: String(p.deliveryAddress).trim().slice(0, 160),
    riderName: 'Preview rider',
    itemSummary,
    subtotal,
    deliveryFee: DEMO_FEE,
    total: subtotal + DEMO_FEE,
    status: 'PLACED',
    restaurantStatus: 'pending',
    isDemo: true,
  });
  row.setACL(new Parse.ACL());
  await row.save(null, MASTER);
  return { id: row.id, orderCode: row.get('orderCode'), total: row.get('total') };
});

Parse.Cloud.define('getPreviewOrders', async () => {
  requirePreview();
  const query = new Parse.Query('DemoOrder');
  query.notContainedIn('status', ['PICKED_UP', 'DELIVERED', 'CANCELLED']);
  query.descending('createdAt');
  query.limit(30);
  let rows = await query.find(MASTER);
  if (!rows.length) {
    const seeds = [
      ['DEMO-0218', 'Joel M.', '2× Smoky chicken bowl · 1× Juice', 43000, 'PLACED'],
      ['DEMO-0217', 'Sarah N.', '2× Garden rice plate', 32000, 'PREPARING'],
      ['DEMO-0214', 'Joseph K.', '1× Chicken bowl · 1× Hibiscus', 24500, 'READY'],
    ];
    rows = seeds.map(([code, customer, items, total, status]) => {
      const row = new Parse.Object('DemoOrder');
      row.set({
        orderCode: code,
        customerName: customer,
        deliveryAddress: 'Kampala Central',
        riderName: 'R-014 · Amina',
        itemSummary: items,
        total,
        status,
        restaurantStatus: String(status).toLowerCase(),
        isDemo: true,
      });
      row.setACL(new Parse.ACL());
      return row;
    });
    await Parse.Object.saveAll(rows, MASTER);
  }
  return rows.map((row) => ({
    id: row.id,
    code: row.get('orderCode'),
    rider: row.get('riderName'),
    customer: row.get('customerName'),
    items: row.get('itemSummary'),
    total: row.get('total'),
    status: row.get('status'),
  }));
});

const DEMO_TRANSITIONS = {
  accept: ['PLACED', 'ACCEPTED'],
  prepare: ['ACCEPTED', 'PREPARING'],
  ready: ['PREPARING', 'READY'],
  pickup: ['READY', 'PICKED_UP'],
};

Parse.Cloud.define('transitionPreviewOrder', async (request) => {
  requirePreview();
  const row = await new Parse.Query('DemoOrder').get(request.params.orderId, MASTER);
  const rule = DEMO_TRANSITIONS[request.params.action];
  if (!rule || row.get('status') !== rule[0]) throw invalid('Invalid preview transition');
  row.set({ status: rule[1], restaurantStatus: rule[1].toLowerCase() });
  await row.save(null, MASTER);
  return { status: rule[1] };
});

module.exports = { previewEnabled };
