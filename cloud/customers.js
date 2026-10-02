// Customers are captured by riders on each order (customers never sign in).
// They power the name type-ahead, saved addresses and "Repeat last order".

const { MASTER, invalid, requireRole, readAcl, audit } = require('./lib/core');

const MAX_ADDRESSES = 5;

// One customer per phone number; customers without a phone are matched by name.
const customerKey = (name, phone) => (phone ? `tel:${phone}` : `name:${name.toLowerCase()}`);

// Called by createOrder after the order is saved. Returns the Customer.
async function recordCustomerOrder(order) {
  const name = order.get('customerName');
  const phone = order.get('customerPhone') || '';
  const key = customerKey(name, phone);
  const query = new Parse.Query('Customer');
  query.equalTo('key', key);
  query.ascending('createdAt');
  const customer = (await query.first(MASTER)) || new Parse.Object('Customer');
  const saved = customer.get('addresses') || [];
  const text = order.get('deliveryAddress');
  const same = (entry) => entry.text.toLowerCase() === text.toLowerCase();
  // The address keeps its map pin: this order's, or the one saved before.
  const pin = order.get('location');
  const previous = saved.find(same);
  const address = {
    text,
    notes: order.get('deliveryNotes') || '',
    ...(pin
      ? { lat: pin.latitude, lng: pin.longitude }
      : previous?.lat !== undefined && { lat: previous.lat, lng: previous.lng }),
  };
  const addresses = [address, ...saved.filter((entry) => !same(entry))].slice(0, MAX_ADDRESSES);
  customer.set({
    key,
    name,
    nameLower: name.toLowerCase(),
    phone,
    addresses,
    orderCount: (customer.get('orderCount') || 0) + 1,
    lastOrderAt: new Date(),
    lastOrder: order,
  });
  customer.setACL(readAcl(null, ['admin']));
  await customer.save(null, MASTER);
  return customer;
}

// Saves a pin on the order's address in the customer's record, so the next
// order to that address is pinned already.
async function pinCustomerAddress(order, location) {
  const pointer = order.get('customer');
  if (!pointer) return;
  const customer = await new Parse.Query('Customer').get(pointer.id, MASTER).catch(() => null);
  if (!customer) return;
  const text = String(order.get('deliveryAddress') || '').toLowerCase();
  const addresses = (customer.get('addresses') || []).map((entry) =>
    entry.text.toLowerCase() === text
      ? {
          ...entry,
          ...(location
            ? { lat: location.lat, lng: location.lng }
            : { lat: undefined, lng: undefined }),
        }
      : entry,
  );
  customer.set(
    'addresses',
    addresses.map((entry) => JSON.parse(JSON.stringify(entry))),
  );
  await customer.save(null, MASTER);
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Top matches by name or phone, most frequent customers first, each with the
// lines of their last order so the rider can repeat it.
Parse.Cloud.define('searchCustomers', async (request) => {
  await requireRole(request, ['rider', 'cashier', 'admin']);
  const text = String(request.params.q || '')
    .trim()
    .toLowerCase()
    .slice(0, 40);
  if (text.length < 2) throw invalid('Type at least 2 characters');
  const byName = new Parse.Query('Customer');
  byName.matches('nameLower', escapeRegex(text));
  const queries = [byName];
  const digits = text.replace(/[^\d]/g, '');
  if (digits.length >= 3) {
    const byPhone = new Parse.Query('Customer');
    byPhone.matches('phone', escapeRegex(digits));
    queries.push(byPhone);
  }
  const query = Parse.Query.or(...queries);
  query.descending('orderCount');
  query.limit(5);
  const customers = await query.find(MASTER);

  const lastOrders = customers.map((c) => c.get('lastOrder')).filter(Boolean);
  const itemQuery = new Parse.Query('OrderItem');
  itemQuery.containedIn('order', lastOrders);
  itemQuery.limit(1000);
  const items = lastOrders.length ? await itemQuery.find(MASTER) : [];
  return customers.map((customer) => {
    const lastId = customer.get('lastOrder')?.id;
    return {
      id: customer.id,
      name: customer.get('name'),
      phone: customer.get('phone') || '',
      addresses: customer.get('addresses') || [],
      orderCount: customer.get('orderCount') || 0,
      lastOrderAt: customer.get('lastOrderAt') || null,
      lastOrder: items
        .filter((item) => item.get('order')?.id === lastId && item.get('menuItem'))
        .map((item) => ({
          menuItemId: item.get('menuItem').id,
          title: item.get('itemNameSnapshot'),
          quantity: item.get('quantity'),
          notes: item.get('notes') || '',
          accompanimentIds: item.get('accompanimentIds') || [],
          accompanimentNames: item.get('accompanimentNames') || [],
        })),
    };
  });
});

// ---------------------------------------------------------------------------
// Customer management (Admin → Customers): the owner and finance.

const customerView = (row) => ({
  id: row.id,
  name: row.get('name'),
  phone: row.get('phone') || '',
  email: row.get('email') || '',
  notes: row.get('notes') || '',
  addresses: row.get('addresses') || [],
  orderCount: row.get('orderCount') || 0,
  lastOrderAt: row.get('lastOrderAt') || null,
  createdAt: row.get('restoredCreatedAt') || row.createdAt,
});

const PAGE = 100;

// { q?, page?, sort?: 'orders' | 'recent' | 'name' }
Parse.Cloud.define('listCustomers', async (request) => {
  await requireRole(request, ['admin', 'finance']);
  const p = request.params;
  const text = String(p.q || '')
    .trim()
    .toLowerCase()
    .slice(0, 40);
  let query = new Parse.Query('Customer');
  if (text) {
    const byName = new Parse.Query('Customer');
    byName.matches('nameLower', escapeRegex(text));
    const queries = [byName];
    const digits = text.replace(/[^\d]/g, '');
    if (digits.length >= 3) {
      const byPhone = new Parse.Query('Customer');
      byPhone.matches('phone', escapeRegex(digits));
      queries.push(byPhone);
    }
    query = Parse.Query.or(...queries);
  }
  const sort = ['orders', 'recent', 'name'].includes(p.sort) ? p.sort : 'orders';
  if (sort === 'orders') query.descending('orderCount');
  else if (sort === 'recent') query.descending('lastOrderAt');
  else query.ascending('nameLower');
  const page = Math.max(0, Math.floor(Number(p.page) || 0));
  query.skip(page * PAGE);
  query.limit(PAGE + 1);
  const [rows, total] = await Promise.all([
    query.find(MASTER),
    // A condition makes Postgres count exactly instead of estimating.
    new Parse.Query('Customer').exists('objectId').count(MASTER),
  ]);
  return {
    customers: rows.slice(0, PAGE).map(customerView),
    more: rows.length > PAGE,
    total,
  };
});

// One customer with their recent orders and what they have spent.
Parse.Cloud.define('getCustomer', async (request) => {
  // Customers are the restaurant's; a branch finance officer sees their
  // orders at that branch.
  const { branch } = await requireRole(request, ['admin', 'finance']);
  const row = await new Parse.Query('Customer')
    .get(String(request.params.id || ''), MASTER)
    .catch(() => null);
  if (!row) throw invalid('Unknown customer');
  const orderQuery = new Parse.Query('Order').equalTo('customer', row);
  if (branch) orderQuery.equalTo('branch', branch);
  const orders = await orderQuery.descending('createdAt').limit(50).find(MASTER);
  const delivered = orders.filter((o) => o.get('status') === 'DELIVERED');
  return {
    ...customerView(row),
    spent: delivered.reduce((n, o) => n + Number(o.get('total') || 0), 0),
    orders: orders.map((o) => ({
      id: o.id,
      code: o.get('orderCode'),
      status: o.get('status'),
      total: Number(o.get('total') || 0),
      at: o.get('restoredCreatedAt') || o.createdAt,
      type: o.get('orderType') || 'delivery',
    })),
  };
});

// { id, name, phone, email, notes }. A new phone must not belong to another
// customer (orders find customers by phone).
Parse.Cloud.define('saveCustomer', async (request) => {
  const { user: actor } = await requireRole(request, ['admin', 'finance']);
  const p = request.params;
  const row = await new Parse.Query('Customer').get(String(p.id || ''), MASTER).catch(() => null);
  if (!row) throw invalid('Unknown customer');
  const before = customerView(row);
  const name = String(p.name ?? row.get('name'))
    .trim()
    .slice(0, 80);
  if (name.length < 2) throw invalid('Enter the customer name');
  const phone = String(p.phone ?? row.get('phone') ?? '')
    .replace(/[^\d+]/g, '')
    .slice(0, 20);
  const key = customerKey(name, phone);
  const clash = await new Parse.Query('Customer')
    .equalTo('key', key)
    .notEqualTo('objectId', row.id)
    .first(MASTER);
  if (clash) throw invalid(`That phone number is already ${clash.get('name')}'s`);
  row.set({
    name,
    nameLower: name.toLowerCase(),
    phone,
    key,
    email: String(p.email ?? row.get('email') ?? '')
      .trim()
      .slice(0, 120),
    notes: String(p.notes ?? row.get('notes') ?? '')
      .trim()
      .slice(0, 300),
  });
  await row.save(null, MASTER);
  await audit(actor, 'customer.updated', row, before, customerView(row));
  return customerView(row);
});

module.exports = { recordCustomerOrder, pinCustomerAddress };
