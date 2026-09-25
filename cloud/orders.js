const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  requireRole,
  getRoleName,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
} = require('./lib/core');
const { computeCommission, sumBy } = require('./lib/money');
const { availableGroups, selectionError } = require('./lib/accompaniments');
const { recordCustomerOrder } = require('./customers');

const CHANNELS = ['walkin', 'phone', 'whatsapp', 'other'];
const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'prepaid'];
const MAX_LINES = 30;

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const cleanPhone = (value) => clean(value, 30).replace(/[^\d+]/g, '');

// Cash the rider is still accountable for: delivered cash orders that have
// not been reconciled. Derived from orders, never stored.
async function riderFloat(rider) {
  const query = new Parse.Query('Order');
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  query.limit(1000);
  return sumBy(await query.find(MASTER), (order) => order.get('amountCollected'));
}

// Accompaniments that exist, are active and are not sold out, by id.
async function servableAccompaniments() {
  const query = new Parse.Query('Accompaniment');
  query.equalTo('active', true);
  query.equalTo('available', true);
  query.limit(1000);
  return new Map((await query.find(MASTER)).map((row) => [row.id, row]));
}

// Validates the rider's cart against the live menu and returns priced lines.
async function priceLines(items) {
  if (!Array.isArray(items) || !items.length) throw invalid('Add at least one item');
  if (items.length > MAX_LINES) throw invalid(`An order can have at most ${MAX_LINES} lines`);
  const menuQuery = new Parse.Query('MenuItem');
  menuQuery.containedIn(
    'objectId',
    items.map((line) => String(line.id)),
  );
  const [menu, accompaniments] = await Promise.all([
    menuQuery.find(MASTER),
    servableAccompaniments(),
  ]);
  const byId = new Map(menu.map((item) => [item.id, item]));
  return items.map((line) => {
    const saved = byId.get(String(line.id));
    const qty = Number(line.quantity);
    if (!saved || !saved.get('active') || !saved.get('availableToday'))
      throw invalid(`${saved?.get('title') || 'An item'} is not available`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw invalid('Invalid quantity');
    const title = saved.get('title');
    const groups = availableGroups(saved.get('accompanimentGroups') || [], (id) =>
      accompaniments.has(id),
    );
    const chosen = (Array.isArray(line.accompaniments) ? line.accompaniments : []).map(String);
    const problem = selectionError(groups, chosen);
    if (problem) throw invalid(`${title}: ${problem}`);
    return {
      menuItem: saved,
      name: title,
      price: Number(saved.get('price')),
      qty,
      notes: clean(line.notes, 140),
      accompanimentIds: chosen,
      accompanimentNames: chosen.map((id) => accompaniments.get(id).get('title')),
    };
  });
}

Parse.Cloud.define('createOrder', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const p = request.params;

  // Idempotency: a retried submit (e.g. after a dropped connection) returns
  // the order that was already created instead of making a second one.
  const clientId = clean(p.clientId, 64);
  if (clientId) {
    const existingQuery = new Parse.Query('Order');
    existingQuery.equalTo('createdBy', rider);
    existingQuery.equalTo('clientId', clientId);
    const existing = await existingQuery.first(MASTER);
    if (existing)
      return {
        id: existing.id,
        orderCode: existing.get('orderCode'),
        total: existing.get('total'),
        duplicate: true,
      };
  }

  const customerName = clean(p.customerName, 80);
  const deliveryAddress = clean(p.deliveryAddress, 200);
  if (!customerName || !deliveryAddress) throw invalid('Customer and address are required');
  const channel = p.channel || 'walkin';
  const paymentMethod = p.paymentMethod || 'cash';
  if (!CHANNELS.includes(channel)) throw invalid('Invalid channel');
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw invalid('Invalid payment method');

  const activeQuery = new Parse.Query('Order');
  activeQuery.equalTo('createdBy', rider);
  activeQuery.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  const [lines, { values: config }, activeCount, float] = await Promise.all([
    priceLines(p.items),
    loadConfig(),
    activeQuery.count(MASTER),
    riderFloat(rider),
  ]);
  if (!config.allowBatching && activeCount)
    throw invalid('Finish your current order before creating another');

  const subtotal = sumBy(lines, (line) => line.price * line.qty);
  const fee = Math.max(0, Math.round(Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0));
  const total = subtotal + fee;
  const isCash = paymentMethod === 'cash';
  const amountToCollect = isCash ? Math.round(Number(p.amountToCollect ?? total)) : 0;
  if (!Number.isFinite(amountToCollect) || amountToCollect < 0)
    throw invalid('Enter the amount to collect');
  const shortfallNote = clean(p.shortfallNote, 200);
  if (isCash && amountToCollect < total && shortfallNote.length < 5)
    throw invalid('The customer is paying less than the total. Add a note explaining why');

  // B2: the rider's cash after this order must stay within the limit.
  const projected = float + (isCash ? amountToCollect : 0);
  if (config.maxRiderFloat > 0 && projected > config.maxRiderFloat)
    throw invalid(
      `Hand over cash first: this order would put ${config.currencySymbol} ${projected.toLocaleString('en-US')} with you (limit ${config.currencySymbol} ${config.maxRiderFloat.toLocaleString('en-US')})`,
    );

  const order = new Parse.Object('Order');
  order.set({
    orderCode: await nextDailyCode('ORD', 4, config.timezone),
    clientId,
    channel,
    createdBy: rider,
    customerName,
    customerPhone: cleanPhone(p.customerPhone),
    deliveryAddress,
    deliveryNotes: clean(p.deliveryNotes, 200),
    subtotal,
    deliveryFee: fee,
    total,
    paymentMethod,
    amountToCollect,
    shortfallNote: isCash && amountToCollect < total ? shortfallNote : '',
    amountCollected: 0,
    status: 'PLACED',
    restaurantStatus: 'pending',
    cashStatus: isCash ? 'NOT_COLLECTED' : 'NOT_APPLICABLE',
    commissionAmount: 0,
    commissionPaid: false,
    disputeFlag: false,
  });
  order.setACL(readAcl(rider));
  await order.save(null, MASTER);

  const children = lines.map((line) => {
    const item = new Parse.Object('OrderItem');
    item.set({
      order,
      menuItem: line.menuItem,
      itemNameSnapshot: line.name,
      unitPriceSnapshot: line.price,
      quantity: line.qty,
      lineTotal: line.price * line.qty,
      notes: line.notes,
      accompanimentIds: line.accompanimentIds,
      accompanimentNames: line.accompanimentNames,
    });
    item.setACL(readAcl(rider));
    return item;
  });
  await Parse.Object.saveAll(children, MASTER);
  const customer = await recordCustomerOrder(order);
  if (customer) {
    order.set('customer', customer);
    await order.save(null, MASTER);
  }
  await audit(rider, 'order.placed', order, null, { status: 'PLACED', total });
  return { id: order.id, orderCode: order.get('orderCode'), total };
});

// action → allowed current statuses, next status, next restaurantStatus.
// `who`: 'staff' (cashier/admin), 'owner' (the rider who created it, or
// staff), or a function deciding per role.
const TRANSITIONS = {
  accept: { from: ['PLACED'], to: 'ACCEPTED', kitchen: 'accepted', who: 'staff' },
  prepare: { from: ['ACCEPTED'], to: 'PREPARING', kitchen: 'preparing', who: 'staff' },
  ready: { from: ['ACCEPTED', 'PREPARING'], to: 'READY', kitchen: 'ready', who: 'staff' },
  pickup: { from: ['READY'], to: 'PICKED_UP', kitchen: 'picked_up', who: 'owner' },
  deliver: { from: ['PICKED_UP'], to: 'DELIVERED', kitchen: 'picked_up', who: 'owner' },
  reject: { from: ['PLACED'], to: 'CANCELLED', kitchen: 'rejected', who: 'staff' },
  cancel: {
    from: ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'],
    to: 'CANCELLED',
    kitchen: 'cancelled',
    who: 'owner',
  },
};

Parse.Cloud.define('transitionOrder', async (request) => {
  const actor = requireUser(request);
  const p = request.params;
  const rule = TRANSITIONS[p.action];
  const order = await new Parse.Query('Order').get(p.orderId, MASTER);
  if (!rule || !rule.from.includes(order.get('status'))) throw invalid('Invalid status transition');
  const role = await getRoleName(actor);
  const staff = ['cashier', 'admin'].includes(role);
  const owner = order.get('createdBy')?.id === actor.id;
  if (rule.who === 'staff' && !staff) throw forbidden('Staff access required');
  if (rule.who === 'owner' && !owner && !staff) throw forbidden('Not allowed');
  const { values: config } = await loadConfig();
  if (p.action === 'pickup' && !staff && config.requireCashierConfirmForPickup)
    throw forbidden('The cashier confirms pickup when handing over the bag');
  if (p.action === 'cancel' && !staff && order.get('status') !== 'PLACED')
    throw forbidden('The kitchen has accepted this order. Ask the cashier to cancel it');

  const before = {
    status: order.get('status'),
    restaurantStatus: order.get('restaurantStatus'),
    paymentMethod: order.get('paymentMethod'),
  };
  order.set({ status: rule.to, restaurantStatus: rule.kitchen });
  const now = new Date();
  if (p.action === 'accept') order.set('acceptedAt', now);
  if (p.action === 'ready') order.set('readyAt', now);
  if (p.action === 'pickup') order.set('pickedUpAt', now);
  if (p.action === 'cancel' || p.action === 'reject') {
    const reason = clean(p.reason, 200);
    if (reason.length < 3) throw invalid('Give a reason');
    order.set({
      cancelledReason: reason,
      cancelledBy: actor,
      cancelledAt: now,
      cashStatus: 'NOT_APPLICABLE',
    });
  }
  if (p.action === 'deliver') {
    const method = p.paymentMethod || order.get('paymentMethod');
    if (!PAYMENT_METHODS.includes(method)) throw invalid('Invalid payment method');
    const isCash = method === 'cash';
    const total = order.get('total');
    const amount = isCash ? Number(p.amountCollected ?? order.get('amountToCollect') ?? total) : 0;
    if (!Number.isFinite(amount) || amount < 0) throw invalid('Enter the amount collected');
    const note = clean(p.shortfallNote, 200) || order.get('shortfallNote') || '';
    if (isCash && amount < total && note.length < 5)
      throw invalid('Collected amount is below the total. Add a note explaining why');
    const rider = await order.get('createdBy').fetch(MASTER);
    order.set({
      paymentMethod: method,
      deliveredAt: now,
      amountCollected: Math.round(amount),
      shortfallNote: isCash && amount < total ? note : '',
      paymentCollectedBy: actor,
      commissionAmount: computeCommission({
        type: rider.get('commissionType') || 'per_order',
        perOrder: rider.get('commissionPerOrder'),
        percent: rider.get('commissionPercent'),
        subtotal: order.get('subtotal'),
        rounding: config.commissionRounding,
      }),
      cashStatus: isCash ? 'WITH_RIDER' : 'NOT_APPLICABLE',
    });
  }
  await order.save(null, MASTER);
  await audit(actor, `order.${p.action}`, order, before, {
    status: rule.to,
    paymentMethod: order.get('paymentMethod'),
    reason: order.get('cancelledReason'),
  });
  return { status: rule.to };
});

// A food/delivery complaint, independent of the cash status.
Parse.Cloud.define('flagOrderIssue', async (request) => {
  const actor = requireUser(request);
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  const role = await getRoleName(actor);
  if (order.get('createdBy')?.id !== actor.id && !['cashier', 'admin'].includes(role))
    throw forbidden('Not allowed');
  const note = clean(request.params.note, 300);
  if (note.length < 5) throw invalid('Describe the problem');
  order.set({ disputeFlag: true, disputeNote: note, disputedBy: actor, disputedAt: new Date() });
  await order.save(null, MASTER);
  await audit(actor, 'order.issue_flagged', order, null, { note });
  return { ok: true };
});

Parse.Cloud.define('resolveOrderIssue', async (request) => {
  const { user: actor } = await requireRole(request, ['admin']);
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  if (!order.get('disputeFlag')) throw invalid('This order has no open issue');
  const resolution = clean(request.params.resolution, 300);
  if (resolution.length < 5) throw invalid('Describe how it was resolved');
  order.set({ disputeFlag: false, disputeResolution: resolution });
  await order.save(null, MASTER);
  await audit(
    actor,
    'order.issue_resolved',
    order,
    { note: order.get('disputeNote') },
    { resolution },
  );
  return { ok: true };
});

module.exports = { riderFloat, servableAccompaniments };
