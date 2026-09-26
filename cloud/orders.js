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
  riderFloat,
  personName,
  requireCashierShift,
} = require('./lib/core');
const { computeCommission, sumBy } = require('./lib/money');
const { availableGroups, selectionError } = require('./lib/accompaniments');
const { recordCustomerOrder } = require('./customers');
const { checkMobileMoney, PENDING } = require('./payments');
const { money, notifyUser, notifyStaff, notifyAdmins, cashLimitAlert } = require('./notifications');

const CHANNELS = ['walkin', 'phone', 'whatsapp', 'other'];
const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'prepaid'];
const MAX_LINES = 30;

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const cleanPhone = (value) => clean(value, 30).replace(/[^\d+]/g, '');

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
  activeQuery.limit(200);
  const [lines, { values: config }, active, float] = await Promise.all([
    priceLines(p.items),
    loadConfig(),
    activeQuery.find(MASTER),
    riderFloat(rider),
  ]);
  if (!config.allowBatching && active.length)
    throw invalid('Finish your current order before creating another');
  // Cash limit: the rider may place an order while their cash (held, plus
  // still to collect on open cash orders) is below the limit, even if that
  // order takes them over it. Once at or over the limit, no new orders of any
  // kind until the cash is delivered and handed over.
  const toCollect = cashToCollect(active);
  if (config.maxRiderFloat > 0 && float + toCollect >= config.maxRiderFloat)
    throw invalid(cashLimitMessage(config, float, toCollect));

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

  // Mobile money: the customer pays the restaurant's merchant code before
  // the order is sent; the cashier confirms it before the kitchen accepts.
  const momo =
    paymentMethod === 'mobile_money'
      ? await checkMobileMoney(config, p.paymentProvider, p.paymentReference)
      : null;

  const order = new Parse.Object('Order');
  order.set({
    orderCode: await nextDailyCode('ORD', 4, config.timezone, {
      className: 'Order',
      field: 'orderCode',
    }),
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
    ...(momo && {
      paymentProvider: momo.provider,
      paymentReference: momo.reference,
      paymentStatus: PENDING,
    }),
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
  await notifyStaff({
    kind: 'order.new',
    tone: 'new',
    title: `New order ${order.get('orderCode')}`,
    body: [
      personName(rider),
      customerName,
      money(config, total),
      momo ? 'mobile money to check' : 'cash',
    ].join(' · '),
    link: '/cashier',
    order,
  });
  const exposure = float + toCollect + (isCash ? amountToCollect : 0);
  return {
    id: order.id,
    orderCode: order.get('orderCode'),
    total,
    // This order takes the rider to or over the limit: it goes ahead, but the
    // next one is blocked until the cash is handed over.
    cashLimitReached: config.maxRiderFloat > 0 && exposure >= config.maxRiderFloat,
  };
});

// action → allowed current statuses, next status, next restaurantStatus.
// `who`: 'staff' (cashier/admin), 'owner' (the rider who created it, or
// staff), or a function deciding per role.
// Cash still to collect on the rider's open (not yet delivered) cash orders.
const cashToCollect = (orders) =>
  sumBy(
    orders.filter((order) => order.get('paymentMethod') === 'cash'),
    (order) => order.get('amountToCollect') ?? order.get('total'),
  );

function cashLimitMessage(config, held, toCollect) {
  const parts = [];
  if (held > 0) parts.push(`you hold ${money(config, held)}`);
  if (toCollect > 0) parts.push(`${money(config, toCollect)} is still to collect on open orders`);
  return `Cash limit reached: ${parts.join(' and ') || 'no cash room left'} (limit ${money(config, config.maxRiderFloat)}). ${
    toCollect > 0 ? 'Deliver and hand over' : 'Hand over'
  } cash before taking new orders`;
}

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
  if (staff && !owner) await requireCashierShift(actor, role);
  const { values: config } = await loadConfig();
  if (p.action === 'pickup' && !staff && config.requireCashierConfirmForPickup)
    throw forbidden('The cashier confirms pickup when handing over the bag');
  if (p.action === 'accept' && [PENDING, 'REJECTED'].includes(order.get('paymentStatus')))
    throw invalid('Confirm the mobile money payment before accepting this order');
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
    const paidByMomo = order.get('paymentMethod') === 'mobile_money';
    if (paidByMomo && method !== 'mobile_money')
      throw invalid('This order was paid by mobile money');
    // Paying by mobile money at the door instead of cash: record the
    // transaction for the cashier to confirm.
    if (!paidByMomo && method === 'mobile_money') {
      const momo = await checkMobileMoney(config, p.paymentProvider, p.paymentReference, order.id);
      order.set({
        paymentProvider: momo.provider,
        paymentReference: momo.reference,
        paymentStatus: PENDING,
      });
    }
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
  await notifyTransition(order, p.action, { staff, owner, actor, config });
  return { status: rule.to };
});

// What the rider sees when the kitchen moves their order, and what the
// kitchen sees when a rider cancels.
const RIDER_MESSAGES = {
  accept: (code) => [`${code} accepted`, 'The kitchen has started on it.'],
  prepare: (code) => [`${code} is being prepared`, ''],
  ready: (code) => [`${code} is ready for pickup`, 'Collect it from the counter.'],
  pickup: (code) => [`${code} handed to you`, 'Deliver it and record the payment.'],
  deliver: (code) => [`${code} marked delivered`, ''],
  reject: (code, reason) => [`${code} was rejected`, reason],
  cancel: (code, reason) => [`${code} was cancelled`, reason],
};

async function notifyTransition(order, action, { staff, owner, actor, config }) {
  const code = order.get('orderCode');
  const rider = order.get('createdBy');
  if (staff && !owner && RIDER_MESSAGES[action]) {
    const [title, detail] = RIDER_MESSAGES[action](code, order.get('cancelledReason') || '');
    await notifyUser(rider, {
      kind: `order.${action}`,
      tone: ['ready', 'reject', 'cancel'].includes(action) ? 'alert' : 'update',
      title,
      body: [order.get('customerName'), detail].filter(Boolean).join(' · '),
      link: `/rider/order/${order.id}`,
      order,
    });
  }
  if (owner && action === 'cancel')
    await notifyStaff({
      kind: 'order.cancelled_by_rider',
      tone: 'update',
      title: `${code} cancelled by the rider`,
      body: order.get('cancelledReason') || '',
      link: '/cashier',
      order,
      except: actor,
    });
  if (action === 'deliver' && order.get('paymentMethod') === 'cash')
    await cashLimitAlert(await rider.fetch(MASTER), config);
}

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
  await notifyAdmins({
    kind: 'order.issue',
    tone: 'alert',
    title: `Problem reported on ${order.get('orderCode')}`,
    body: `${personName(await actor.fetch(MASTER))}: ${note}`,
    link: '/admin/problems',
    order,
    except: actor,
  });
  return { ok: true };
});

Parse.Cloud.define('resolveOrderIssue', async (request) => {
  const { user: actor } = await requireRole(request, ['admin']);
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  if (!order.get('disputeFlag')) throw invalid('This order has no open issue');
  const resolution = clean(request.params.resolution, 300);
  if (resolution.length < 5) throw invalid('Describe how it was resolved');
  order.set({
    disputeFlag: false,
    disputeResolution: resolution,
    disputeResolvedBy: actor,
    disputeResolvedAt: new Date(),
  });
  await order.save(null, MASTER);
  await audit(
    actor,
    'order.issue_resolved',
    order,
    { note: order.get('disputeNote') },
    { resolution },
  );
  const resolved = {
    kind: 'order.issue_resolved',
    tone: 'update',
    title: `Problem on ${order.get('orderCode')} resolved`,
    body: resolution,
    order,
    except: actor,
  };
  const rider = order.get('createdBy');
  const reporter = order.get('disputedBy');
  await notifyUser(rider, { ...resolved, link: `/rider/order/${order.id}` });
  if (reporter && reporter.id !== rider?.id) await notifyUser(reporter, { ...resolved, link: '' });
  return { ok: true };
});

// Owner: problems reported on orders, open first.
Parse.Cloud.define('adminListIssues', async (request) => {
  await requireRole(request, ['admin']);
  const state = request.params.state || 'open';
  if (!['open', 'resolved', 'all'].includes(state)) throw invalid('Unknown issue filter');
  const query = new Parse.Query('Order');
  query.exists('disputeNote');
  if (state === 'open') query.equalTo('disputeFlag', true);
  if (state === 'resolved') query.notEqualTo('disputeFlag', true);
  query.include(['createdBy', 'disputedBy', 'disputeResolvedBy']);
  query.descending('disputedAt');
  query.limit(300);
  const [rows, open] = await Promise.all([
    query.find(MASTER),
    new Parse.Query('Order').equalTo('disputeFlag', true).count(MASTER),
  ]);
  return {
    open,
    issues: rows.map((order) => ({
      id: order.id,
      code: order.get('orderCode'),
      customer: order.get('customerName'),
      customerPhone: order.get('customerPhone') || '',
      rider: personName(order.get('createdBy')),
      status: order.get('status'),
      total: order.get('total'),
      note: order.get('disputeNote'),
      reportedBy: personName(order.get('disputedBy')),
      reportedAt: order.get('disputedAt') || null,
      open: order.get('disputeFlag') === true,
      resolution: order.get('disputeResolution') || '',
      resolvedBy: personName(order.get('disputeResolvedBy')),
      resolvedAt: order.get('disputeResolvedAt') || null,
    })),
  };
});

module.exports = { riderFloat, servableAccompaniments };
