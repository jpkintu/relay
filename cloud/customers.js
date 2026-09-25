// Customers are captured by riders on each order (customers never sign in).
// They power the name type-ahead, saved addresses and "Repeat last order".

const { MASTER, invalid, requireRole, readAcl } = require('./lib/core');

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
  const address = { text: order.get('deliveryAddress'), notes: order.get('deliveryNotes') || '' };
  const addresses = [
    address,
    ...(customer.get('addresses') || []).filter(
      (saved) => saved.text.toLowerCase() !== address.text.toLowerCase(),
    ),
  ].slice(0, MAX_ADDRESSES);
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

module.exports = { recordCustomerOrder };
