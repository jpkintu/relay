// The owner's order page and overrides: cancel at any stage before delivery,
// fix how a delivered order was paid, mark a stuck order delivered or undo a
// delivery made by mistake, and move an open order to another rider. Every
// override needs a reason, is audited and tells the rider(s).

const {
  MASTER,
  invalid,
  forbidden,
  adminOnly,
  requireRole,
  getRoleName,
  readAcl,
  audit,
  loadConfig,
  personName,
} = require('./lib/core');
const { orderRiderPay } = require('./lib/money');
const { applyDelivery } = require('./orders');
const { checkMobileMoney, PENDING } = require('./payments');
const { money, notifyUser, notifyStaff } = require('./notifications');

const OPEN = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'];
const ACTIONS = ['cancel', 'payment', 'deliver', 'reopen', 'move'];

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

const unsetIfSet = (object, ...keys) => keys.forEach((key) => object.has(key) && object.unset(key));

// What changed, for the audit log.
const snapshot = (order) => ({
  status: order.get('status'),
  riderId: order.get('createdBy')?.id,
  paymentMethod: order.get('paymentMethod'),
  paymentStatus: order.get('paymentStatus') || null,
  cashStatus: order.get('cashStatus'),
  amountCollected: order.get('amountCollected') || 0,
  commissionAmount: order.get('commissionAmount') || 0,
});

const idOf = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value) ? value : '';

async function orderAudit(order) {
  const query = new Parse.Query('AuditLog');
  query.equalTo('entityType', 'Order');
  query.equalTo('entityId', order.id);
  query.include('actor');
  query.ascending('createdAt');
  query.limit(200);
  const parse = (json) => {
    try {
      return JSON.parse(json || '{}');
    } catch {
      return {};
    }
  };
  return (await query.find(MASTER)).map((row) => ({
    id: row.id,
    at: row.createdAt,
    action: row.get('action'),
    actor: personName(row.get('actor')) || 'System',
    before: parse(row.get('beforeJson')),
    after: parse(row.get('afterJson')),
  }));
}

// Owner: everything about one order.
// The id Relay gave the payment request, as each provider shows it: MTN keeps
// the UUID (X-Reference-Id), Airtel the same without dashes.
const requestReference = (order) => {
  const id = order.get('payRequestId') || '';
  return order.get('paymentProvider') === 'airtel' ? id.replace(/-/g, '') : id;
};

Parse.Cloud.define('adminGetOrder', async (request) => {
  // Finance reads orders; only the owner changes them (adminOverrideOrder).
  const { role } = await requireRole(request, ['admin', 'finance']);
  const id = idOf(request.params.id);
  if (!id) throw invalid('Unknown order');
  const query = new Parse.Query('Order');
  query.include(['createdBy', 'cashier', 'cancelledBy', 'paymentCheckedBy', 'customer']);
  const order = await query.get(id, MASTER);
  const itemQuery = new Parse.Query('OrderItem');
  itemQuery.equalTo('order', order);
  itemQuery.limit(200);
  const handoverQuery = new Parse.Query('CashHandover');
  handoverQuery.equalTo('orders', order);
  handoverQuery.include('cashier');
  handoverQuery.descending('createdAt');
  const [items, history, handovers] = await Promise.all([
    itemQuery.find(MASTER),
    orderAudit(order),
    handoverQuery.find(MASTER),
  ]);
  const rider = order.get('createdBy');
  const status = order.get('status');
  const at = (key) => order.get(key) || null;
  return {
    id: order.id,
    code: order.get('orderCode'),
    status,
    restaurantStatus: order.get('restaurantStatus'),
    channel: order.get('channel'),
    rider: { id: rider?.id || '', name: personName(rider) },
    cashier: personName(order.get('cashier')),
    location: order.get('location')
      ? { lat: order.get('location').latitude, lng: order.get('location').longitude }
      : null,
    customer: {
      name: order.get('customerName') || '',
      phone: order.get('customerPhone') || '',
      address: order.get('deliveryAddress') || '',
      notes: order.get('deliveryNotes') || '',
    },
    items: items.map((item) => ({
      id: item.id,
      name: item.get('itemNameSnapshot'),
      qty: item.get('quantity'),
      price: item.get('unitPriceSnapshot'),
      total: item.get('lineTotal'),
      notes: item.get('notes') || '',
      accompaniments: item.get('accompanimentNames') || [],
      accompanimentPrices: item.get('accompanimentPrices') || [],
      split: item.get('split') || '',
    })),
    splits: order.get('splits') || [],
    subtotal: order.get('subtotal') || 0,
    deliveryFee: order.get('deliveryFee') || 0,
    total: order.get('total') || 0,
    payment: {
      method: order.get('paymentMethod'),
      provider: order.get('paymentProvider') || '',
      reference: order.get('paymentReference') || '',
      status: order.get('paymentStatus') || '',
      checkedBy: personName(order.get('paymentCheckedBy')),
      rejectReason: order.get('paymentRejectReason') || '',
      paidAtDoor: order.get('paidAtDoor') === true,
      amountCollected: order.get('amountCollected') || 0,
      cashStatus: order.get('cashStatus') || '',
      // Automatic payments: confirmed by the provider, and the reference to
      // look the request up in the MTN / Airtel portal.
      auto: order.get('paymentAuto') === true,
      requestStatus: order.get('payRequestStatus') || '',
      requestReference: requestReference(order),
      requestPhone: order.get('payRequestPhone') || '',
      requestError: order.get('payRequestError') || '',
    },
    riderPay:
      status === 'DELIVERED'
        ? {
            total: orderRiderPay(order),
            commission: order.get('commissionBase') ?? null,
            deliveryFee: order.get('deliveryPay') ?? null,
            paid: order.get('commissionPaid') === true,
            feePaid: order.get('deliveryFeePaid') === true,
          }
        : null,
    times: {
      placed: require('./lib/placed').placedAt(order),
      accepted: at('acceptedAt'),
      ready: at('readyAt'),
      pickedUp: at('pickedUpAt'),
      delivered: at('deliveredAt'),
      cancelled: at('cancelledAt'),
    },
    cancelledReason: order.get('cancelledReason') || '',
    cancelledBy: personName(order.get('cancelledBy')),
    handovers: handovers.map((h) => ({
      id: h.id,
      code: h.get('handoverCode'),
      status: h.get('status'),
      cashier: personName(h.get('cashier')),
      at: h.get('handedOverAt') || h.createdAt,
    })),
    history,
    // What the owner may do now (see adminOverrideOrder).
    can: role === 'admin' ? overrideOptions(order) : {},
    // Tax (EFRIS): the sale's fiscal receipt, if EFRIS is on.
    efris: await require('./efris').receiptView(order, (await loadConfig()).values),
  };
});

function overrideOptions(order) {
  const status = order.get('status');
  const method = order.get('paymentMethod');
  const delivered = status === 'DELIVERED';
  const riderPaid = order.get('commissionPaid') === true || order.get('deliveryFeePaid') === true;
  const cashWithRider = method === 'cash' && order.get('cashStatus') === 'WITH_RIDER';
  const momoUnverified = method === 'mobile_money' && order.get('paymentStatus') !== 'VERIFIED';
  // Eat-in / pick-up orders never go out with a rider.
  const withRider =
    !['eat_in', 'pickup'].includes(order.get('orderType')) && !!order.get('createdBy');
  return {
    cancel: OPEN.includes(status),
    deliver: withRider && ['READY', 'PICKED_UP'].includes(status),
    move: withRider && OPEN.includes(status),
    reopen: delivered && !riderPaid && (cashWithRider || momoUnverified),
    paymentToMobileMoney: delivered && cashWithRider,
    paymentToCash: delivered && momoUnverified,
  };
}

// Owner: override an order. params: { id, action, reason, ... }
//   cancel                         any open order (not delivered)
//   payment  { method, provider?, reference? }
//            cash → mobile money while the cash is still with the rider;
//            mobile money → cash while it is not verified
//   deliver  { method?, provider?, reference? }  a READY or PICKED_UP order
//   reopen                         undo a delivery: money not handed over or
//                                  verified, rider not paid for it
//   move     { riderId }           an open order to another active rider
Parse.Cloud.define('adminOverrideOrder', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  if (!ACTIONS.includes(p.action)) throw invalid('Unknown override');
  const reason = clean(p.reason, 300);
  if (reason.length < 5) throw invalid('Say why (at least 5 characters)');
  const id = idOf(p.id);
  if (!id) throw invalid('Unknown order');
  const order = await new Parse.Query('Order').get(id, MASTER);
  const can = overrideOptions(order);
  const before = snapshot(order);
  const { values: config } = await loadConfig();
  const code = order.get('orderCode');
  const rider = order.get('createdBy');
  const notices = [];
  const now = new Date();

  if (p.action === 'cancel') {
    if (!can.cancel) throw invalid('Only orders not yet delivered can be cancelled');
    order.set({
      status: 'CANCELLED',
      restaurantStatus: 'cancelled',
      cancelledReason: reason,
      cancelledBy: actor,
      cancelledAt: now,
      cashStatus: 'NOT_APPLICABLE',
    });
    notices.push([rider, `${code} was cancelled by the owner`, reason, 'alert']);
    if (order.get('paymentStatus') === 'VERIFIED')
      notices.push(['staff', `${code} was cancelled after payment`, 'Refund the customer.']);
  }

  if (p.action === 'payment') {
    if (p.method === 'mobile_money') {
      if (!can.paymentToMobileMoney)
        throw invalid('Only a delivered cash order whose cash is still with the rider can switch');
      const momo = await checkMobileMoney(
        config,
        p.provider,
        p.reference,
        order.id,
        p.payerPhone || order.get('customerPhone'),
      );
      order.set({
        ...momo.request,
        paymentMethod: 'mobile_money',
        paymentProvider: momo.provider,
        paymentReference: momo.reference,
        paymentStatus: PENDING,
        paidAtDoor: true,
        amountCollected: 0,
        cashStatus: 'NOT_APPLICABLE',
      });
      unsetIfSet(order, 'paymentRejectReason', 'paymentCheckedBy', 'paymentCheckedAt');
      notices.push([
        rider,
        `${code} changed to mobile money`,
        `${reason}. It is off your cash; a cashier checks the payment.`,
      ]);
      notices.push(['staff', `${code}: mobile money to check`, `Changed by the owner: ${reason}`]);
    } else if (p.method === 'cash') {
      if (!can.paymentToCash)
        throw invalid('Only a delivered mobile money order that is not verified can switch');
      order.set({
        paymentMethod: 'cash',
        amountCollected: Number(order.get('amountToCollect') || order.get('total') || 0),
        cashStatus: 'WITH_RIDER',
      });
      unsetIfSet(
        order,
        'paymentProvider',
        'paymentReference',
        'paymentStatus',
        'paidAtDoor',
        'paymentRejectReason',
        'paymentCheckedBy',
        'paymentCheckedAt',
      );
      notices.push([
        rider,
        `${code} changed to cash`,
        `${reason}. Hand over ${money(config, order.get('amountCollected'))}.`,
        'alert',
      ]);
    } else throw invalid('Choose cash or mobile money');
  }

  if (p.action === 'deliver') {
    if (!can.deliver) throw invalid('Only a ready or picked-up order can be marked delivered');
    if (!order.get('pickedUpAt')) order.set('pickedUpAt', now);
    order.set({ status: 'DELIVERED', restaurantStatus: 'picked_up' });
    await applyDelivery(order, {
      method: p.method,
      provider: p.provider,
      reference: p.reference,
      actor,
      config,
      now,
    });
    notices.push([
      rider,
      `${code} marked delivered by the owner`,
      order.get('paymentMethod') === 'cash'
        ? `${reason}. You hold ${money(config, order.get('amountCollected'))} for it.`
        : reason,
    ]);
  }

  if (p.action === 'reopen') {
    if (!can.reopen)
      throw invalid(
        'Only a delivery whose money is still with the rider (not handed over or verified) and whose rider pay is unpaid can be undone',
      );
    const doorMomo =
      order.get('paidAtDoor') === true && order.get('paymentMethod') === 'mobile_money';
    const wasCash = order.get('paymentMethod') === 'cash' || doorMomo;
    order.set({
      status: 'PICKED_UP',
      restaurantStatus: 'picked_up',
      amountCollected: 0,
      commissionAmount: 0,
      commissionPaid: false,
      cashStatus: wasCash ? 'NOT_COLLECTED' : 'NOT_APPLICABLE',
    });
    if (wasCash) order.set('paymentMethod', 'cash');
    unsetIfSet(order, 'deliveredAt', 'commissionBase', 'deliveryPay', 'paymentCollectedBy');
    if (doorMomo || order.get('paidAtDoor'))
      unsetIfSet(
        order,
        'paymentProvider',
        'paymentReference',
        'paymentStatus',
        'paidAtDoor',
        'paymentRejectReason',
        'paymentCheckedBy',
        'paymentCheckedAt',
      );
    notices.push([
      rider,
      `${code} is open again`,
      `${reason}. Deliver it when it reaches the customer.`,
      'alert',
    ]);
  }

  if (p.action === 'move') {
    if (!can.move) throw invalid('Only orders not yet delivered can move to another rider');
    const next = await new Parse.Query(Parse.User)
      .get(idOf(p.riderId) || 'none', MASTER)
      .catch(() => null);
    if (!next || (await getRoleName(next)) !== 'rider') throw invalid('Choose a rider');
    if (next.get('active') === false) throw forbidden('That rider is deactivated');
    if (next.id === rider?.id) throw invalid('The order is already with that rider');
    order.set('createdBy', next);
    order.setACL(readAcl(next));
    const items = await new Parse.Query('OrderItem')
      .equalTo('order', order)
      .limit(200)
      .find(MASTER);
    items.forEach((item) => item.setACL(readAcl(next)));
    if (items.length) await Parse.Object.saveAll(items, MASTER);
    const fresh = await next.fetch(MASTER);
    notices.push([rider, `${code} moved to ${personName(fresh)}`, reason, 'alert']);
    notices.push([
      next,
      `${code} is now yours`,
      `${reason} · ${order.get('customerName')}`,
      'alert',
    ]);
  }

  await order.save(null, MASTER);
  const after = { ...snapshot(order), reason };
  if (p.method) after.method = p.method;
  await audit(actor, `order.override_${p.action}`, order, before, after);
  for (const [to, title, body, tone = 'update'] of notices) {
    const payload = {
      kind: `order.override_${p.action}`,
      tone,
      title,
      body,
      order,
    };
    if (to === 'staff') await notifyStaff({ ...payload, link: '/cashier', except: actor });
    else if (to) await notifyUser(to, { ...payload, link: `/rider/order/${order.id}` });
  }
  return { ok: true, status: order.get('status') };
});

module.exports = { overrideOptions };
