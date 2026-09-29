// Customer privacy (Admin → Data & privacy). Customers' names, phone numbers,
// addresses and map pins are personal data. The owner chooses how long to
// keep them; after that they are removed from old orders and the customer
// list, while the amounts stay for the books. A customer can also ask to be
// forgotten at once. The privacy notice (/privacy) reads the same settings.

const { MASTER, audit, findAll, invalid, loadConfig, readAcl } = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');

const RETENTION_CHOICES = [0, 6, 12, 24, 36];
const REMOVED_NAME = 'Customer (details removed)';
// Orders whose money is still being settled keep their details.
const OPEN_CASH = ['WITH_RIDER', 'HANDOVER_PENDING', 'DISPUTED'];

function stripOrder(order) {
  order.set({
    customerName: REMOVED_NAME,
    customerPhone: '',
    deliveryAddress: '',
    deliveryNotes: '',
    anonymisedAt: new Date(),
  });
  for (const field of ['location', 'customer']) if (order.has(field)) order.unset(field);
}

async function saveInBatches(objects) {
  for (let i = 0; i < objects.length; i += 200)
    await Parse.Object.saveAll(objects.slice(i, i + 200), MASTER);
}

// Removes customer details older than the chosen period. `now` is only
// moved by tests (master key). Returns what was (or, dryRun, would be) done.
async function applyRetention({ months, now = new Date(), dryRun = false }) {
  if (!months) return { months: 0, orders: 0, customers: 0, notifications: 0 };
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  // Restored orders count by their original time (lib/placed.js).
  const orderQuery = require('./lib/placed').createdIn('Order', { end: cutoff });
  orderQuery.containedIn('status', ['DELIVERED', 'CANCELLED']);
  orderQuery.doesNotExist('anonymisedAt');
  const customerQuery = new Parse.Query('Customer');
  customerQuery.lessThan('lastOrderAt', cutoff);
  // Notifications name customers too; old ones are simply removed.
  const noteQuery = new Parse.Query('Notification');
  noteQuery.lessThan('createdAt', cutoff);
  const [orders, customers, notes] = await Promise.all([
    findAll(orderQuery).catch(() => []),
    findAll(customerQuery).catch(() => []),
    findAll(noteQuery).catch(() => []),
  ]);
  const due = orders.filter(
    (order) => !OPEN_CASH.includes(order.get('cashStatus')) && order.get('billOpen') !== true,
  );
  if (!dryRun) {
    due.forEach(stripOrder);
    await saveInBatches(due);
    if (customers.length) await Parse.Object.destroyAll(customers, MASTER);
    if (notes.length) await Parse.Object.destroyAll(notes, MASTER);
  }
  return {
    months,
    cutoff: cutoff.toISOString(),
    orders: due.length,
    customers: customers.length,
    notifications: notes.length,
  };
}

// Nightly, from the cashCheck job.
async function runRetention() {
  const { values } = await loadConfig();
  const months = Number(values.retentionMonths) || 0;
  const result = await applyRetention({ months });
  if (result.orders || result.customers || result.notifications)
    await audit(null, 'privacy.retention', { className: 'Privacy', id: 'retention' }, null, result);
  return result;
}

// Owner: who customers contact about their data, and how long details are kept.
Parse.Cloud.define('adminSavePrivacy', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const months = Number(p.retentionMonths);
  if (!RETENTION_CHOICES.includes(months)) throw invalid('Choose how long to keep details');
  const contact = String(p.privacyContact ?? '')
    .trim()
    .slice(0, 200);
  const { object } = await loadConfig();
  const config = object || new Parse.Object('Configuration');
  const before = {
    retentionMonths: config.get('retentionMonths') ?? 0,
    privacyContact: config.get('privacyContact') || '',
  };
  config.set({ retentionMonths: months, privacyContact: contact });
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  await audit(actor, 'privacy.settings_saved', config, before, {
    retentionMonths: months,
    privacyContact: contact,
  });
  return { retentionMonths: months, privacyContact: contact };
});

// Owner: run the clean-up now, or see what it would remove ({ dryRun }).
Parse.Cloud.define('adminApplyRetention', async (request) => {
  // The master key (tests, the dashboard) may also move "now" forward.
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const { values } = await loadConfig();
  const months = Number(values.retentionMonths) || 0;
  if (!months) throw invalid('Choose how long to keep customer details first');
  const now = request.master && p.asOf ? new Date(p.asOf) : new Date();
  const result = await applyRetention({ months, now, dryRun: !!p.dryRun });
  if (!p.dryRun)
    await audit(
      actor,
      'privacy.retention',
      { className: 'Privacy', id: 'retention' },
      null,
      result,
    );
  return result;
});

// Owner: a customer asked to be forgotten. { phone } or { customerId };
// dryRun shows what would be removed. Their details are removed from every
// finished order (amounts stay) and their saved record is deleted. Orders
// still in progress keep the details until they are done.
Parse.Cloud.define('adminForgetCustomer', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const phone = String(p.phone || '').replace(/[^\d+]/g, '');
  if (p.customerId && !/^[A-Za-z0-9]{1,32}$/.test(String(p.customerId)))
    throw invalid('Unknown customer');
  if (!p.customerId && phone.length < 7) throw invalid('Enter the customer’s phone number');
  const customer = p.customerId
    ? await new Parse.Query('Customer').get(String(p.customerId), MASTER).catch(() => null)
    : await new Parse.Query('Customer').equalTo('phone', phone).first(MASTER);
  const byPointer = customer ? new Parse.Query('Order').equalTo('customer', customer) : null;
  const byPhone = phone || customer?.get('phone');
  const queries = [
    byPointer,
    byPhone && new Parse.Query('Order').equalTo('customerPhone', byPhone),
  ].filter(Boolean);
  if (!queries.length) return { found: false, orders: 0, inProgress: 0 };
  const orders = await findAll(Parse.Query.or(...queries));
  const done = orders.filter(
    (order) =>
      ['DELIVERED', 'CANCELLED'].includes(order.get('status')) &&
      !OPEN_CASH.includes(order.get('cashStatus')) &&
      order.get('billOpen') !== true &&
      !order.get('anonymisedAt'),
  );
  const inProgress = orders.filter((order) => !done.includes(order) && !order.get('anonymisedAt'));
  const summary = {
    found: !!customer || orders.length > 0,
    name: customer?.get('name') || orders[0]?.get('customerName') || '',
    orders: done.length,
    inProgress: inProgress.length,
  };
  if (p.dryRun || !summary.found) return summary;
  done.forEach(stripOrder);
  await saveInBatches(done);
  // Kept only while an order is still open, so it can be delivered.
  if (customer && !inProgress.length) await customer.destroy(MASTER);
  await audit(
    actor,
    'privacy.customer_forgotten',
    { className: 'Customer', id: customer?.id || 'phone' },
    null,
    {
      orders: done.length,
      inProgress: inProgress.length,
    },
  );
  return summary;
});

module.exports = { runRetention, applyRetention, RETENTION_CHOICES };
