const {
  MASTER,
  invalid,
  requireRole,
  adminOnly,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
} = require('./lib/core');
const { sumBy } = require('./lib/money');

Parse.Cloud.define('createHandover', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const ids = request.params.orderIds;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw invalid('Select unique orders');
  const query = new Parse.Query('Order');
  query.containedIn('objectId', ids);
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.equalTo('cashStatus', 'WITH_RIDER');
  const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
  if (orders.length !== ids.length) throw invalid('Invalid handover orders');

  const amount = sumBy(orders, (order) => order.get('amountCollected'));
  const row = new Parse.Object('CashHandover');
  row.set({
    handoverCode: await nextDailyCode('HO', 3, config.timezone, {
      className: 'CashHandover',
      field: 'handoverCode',
    }),
    rider,
    amount,
    orderCount: orders.length,
    orders,
    status: 'pending',
    handedOverAt: new Date(),
    notes: String(request.params.notes || ''),
  });
  row.setACL(readAcl(rider));
  await row.save(null, MASTER);
  orders.forEach((order) => order.set('cashStatus', 'HANDOVER_PENDING'));
  await Parse.Object.saveAll(orders, MASTER);
  await audit(rider, 'cash.handover_created', row, null, { amount });
  return { id: row.id, amount };
});

Parse.Cloud.define('confirmHandover', async (request) => {
  const { user: cashier } = await requireRole(request, ['cashier', 'admin']);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, MASTER);
  if (row.get('status') !== 'pending') throw invalid('Already resolved');
  const counted = Number(request.params.countedAmount);
  if (!Number.isFinite(counted) || counted !== Number(row.get('amount')))
    throw invalid('Counted cash must match the claim; dispute any variance');
  const orders = await Promise.all((row.get('orders') || []).map((ptr) => ptr.fetch(MASTER)));
  if (orders.some((order) => order.get('cashStatus') !== 'HANDOVER_PENDING'))
    throw invalid('Orders are no longer pending this handover');
  orders.forEach((order) => order.set({ cashStatus: 'RECONCILED', settledAt: new Date() }));
  await Parse.Object.saveAll(orders, MASTER);
  row.set({ status: 'confirmed', cashier, confirmedAt: new Date(), countedAmount: counted });
  await row.save(null, MASTER);
  await audit(
    cashier,
    'cash.handover_confirmed',
    row,
    { status: 'pending' },
    { status: 'confirmed', countedAmount: counted },
  );
  return { status: 'confirmed' };
});

Parse.Cloud.define('disputeHandover', async (request) => {
  const { user: cashier } = await requireRole(request, ['cashier', 'admin']);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, MASTER);
  if (row.get('status') !== 'pending') throw invalid('Only pending handovers can be disputed');
  const reason = String(request.params.reason || '').trim();
  const counted = Number(request.params.countedAmount);
  if (reason.length < 5 || !Number.isFinite(counted) || counted < 0)
    throw invalid('Enter a reason and physical cash count');
  row.set({
    status: 'disputed',
    cashier,
    disputeReason: reason,
    countedAmount: counted,
    disputedAt: new Date(),
  });
  await row.save(null, MASTER);
  await audit(
    cashier,
    'cash.handover_disputed',
    row,
    { status: 'pending', amount: row.get('amount') },
    { status: 'disputed', countedAmount: counted, reason },
  );
  return { status: 'disputed' };
});

Parse.Cloud.define('reopenHandover', async (request) => {
  const actor = await adminOnly(request);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, MASTER);
  if (row.get('status') !== 'disputed') throw invalid('Only disputed handovers can be reopened');
  const note = String(request.params.note || '').trim();
  if (note.length < 5) throw invalid('Enter a resolution note');
  row.set({ status: 'pending', resolutionNote: note, resolvedBy: actor, resolvedAt: new Date() });
  await row.save(null, MASTER);
  await audit(
    actor,
    'cash.dispute_reopened',
    row,
    { status: 'disputed', reason: row.get('disputeReason') },
    { status: 'pending', note },
  );
  return { status: 'pending' };
});
