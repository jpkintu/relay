// Orders created at the counter by a cashier (or the owner), for restaurants
// that switch these modules on in Settings:
//
//   Call-in delivery (moduleCallIn): a customer phones or messages the
//   restaurant; the cashier creates a delivery order and assigns a rider. The
//   customer either pays the rider cash at the door or has paid by mobile
//   money (the cashier records the transaction ID). On these orders the rider
//   earns the delivery fee only, no commission.
//
//   Eat-in and pick-up (moduleCounter): a walk-in customer orders at the
//   counter. They pay when ordering or later (an open bill); cash goes into
//   the cashier's till and counts in the expected till at the end of the
//   shift. The kitchen marks the order Served / Collected once it is paid.

const {
  MASTER,
  invalid,
  forbidden,
  requireRole,
  getRoleName,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
  personName,
  requireCashierShift,
  orNone,
  findAll,
} = require('./lib/core');
const { sumBy } = require('./lib/money');
const { cleanLocation } = require('./lib/geo');
const { recordCustomerOrder } = require('./customers');
const { checkMobileMoney, checkCard, PENDING } = require('./payments');
const { money, notifyUser, notifyStaff } = require('./notifications');
const {
  priceLines,
  saveLines,
  splitFields,
  clean,
  cleanPhone,
  CHANNELS,
  PINNED_ONLY,
} = require('./orders');

const ORDER_TYPES = ['delivery', 'eat_in', 'pickup'];
const COUNTER_TYPES = ['eat_in', 'pickup'];
const OPEN = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'];
const TYPE_LABEL = { delivery: 'Delivery', eat_in: 'Eat in', pickup: 'Pick up' };

const idOf = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value) ? value : '';

// Which counter modules are on (Settings → Modules).
const modulesOf = (config) => ({
  riderOrders: config.moduleRiderOrders !== false,
  callIn: config.moduleCallIn === true,
  counter: config.moduleCounter === true,
});

async function openShiftOf(user) {
  return new Parse.Query('Shift')
    .equalTo('operator', user)
    .equalTo('kind', 'cashier')
    .equalTo('status', 'open')
    .first(MASTER);
}

// An active rider by id, or an error.
async function activeRider(riderId) {
  const id = idOf(riderId);
  const rider = id ? await new Parse.Query(Parse.User).get(id, MASTER).catch(() => null) : null;
  if (!rider || (await getRoleName(rider)) !== 'rider') throw invalid('Choose a rider');
  if (rider.get('active') === false) throw forbidden('That rider is deactivated');
  // A rider on a break (on shift, marked unavailable) takes no new orders.
  if (rider.get('available') === false) {
    const onShift = await new Parse.Query('Shift')
      .equalTo('kind', 'rider')
      .equalTo('operator', rider)
      .equalTo('status', 'open')
      .first(MASTER);
    if (onShift) throw forbidden(`${personName(rider)} is on a break. Choose another rider`);
  }
  return rider;
}

// Cash taken at the counter goes into this cashier's till now.
async function cashIntoTill(order, actor, role) {
  const shift = role === 'cashier' ? await openShiftOf(actor) : null;
  order.set({
    paymentMethod: 'cash',
    cashStatus: 'IN_TILL',
    amountCollected: Number(order.get('total') || 0),
    paidAt: new Date(),
    tillCashier: actor,
    billOpen: false,
    ...(shift && { tillShift: shift }),
  });
}

async function assign(order, rider) {
  order.set('createdBy', rider);
  order.setACL(readAcl(rider));
  const items = await new Parse.Query('OrderItem').equalTo('order', order).limit(200).find(MASTER);
  items.forEach((item) => item.setACL(readAcl(rider)));
  if (items.length) await Parse.Object.saveAll(items, MASTER);
}

async function tellRider(rider, order, config) {
  await notifyUser(rider, {
    kind: 'order.assigned',
    tone: 'new',
    title: `New delivery ${order.get('orderCode')}`,
    body: [
      order.get('customerName'),
      order.get('deliveryAddress'),
      order.get('paymentMethod') === 'cash'
        ? `collect ${money(config, order.get('total'))}`
        : 'paid by mobile money',
      `you earn the ${money(config, order.get('deliveryFee'))} delivery fee`,
    ]
      .filter(Boolean)
      .join(' · '),
    link: `/rider/order/${order.id}`,
    order,
  });
}

// Cashier/admin: create a call-in delivery, eat-in or pick-up order.
// params: { orderType, customerName, customerPhone, channel, items,
//   delivery: deliveryAddress, deliveryNotes, location, deliveryFee, riderId?
//   eat-in / pick-up: table?
//   paymentMethod: 'cash' | 'mobile_money' | 'card' (eat-in / pick-up),
//   paymentProvider, paymentReference,
//   payLater (eat-in / pick-up only), clientId }
Parse.Cloud.define('createCounterOrder', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  const p = request.params;
  const { values: config } = await loadConfig();
  const modules = modulesOf(config);
  const type = p.orderType;
  if (!ORDER_TYPES.includes(type)) throw invalid('Choose delivery, eat in or pick up');
  if (type === 'delivery' && !modules.callIn)
    throw forbidden('Call-in delivery orders are switched off in Settings');
  if (type !== 'delivery' && !modules.counter)
    throw forbidden('Eat-in and pick-up orders are switched off in Settings');

  const clientId = clean(p.clientId, 64);
  if (clientId) {
    const existing = await new Parse.Query('Order')
      .equalTo('placedBy', actor)
      .equalTo('clientId', clientId)
      .first(MASTER)
      .catch(orNone(undefined));
    if (existing)
      return {
        id: existing.id,
        orderCode: existing.get('orderCode'),
        total: existing.get('total'),
        duplicate: true,
      };
  }

  const isDelivery = type === 'delivery';
  const customerName =
    clean(p.customerName, 80) || (isDelivery ? '' : type === 'eat_in' ? 'Eat-in guest' : 'Pick-up');
  const pin = isDelivery ? cleanLocation(p.location) : { location: null };
  if (pin.error) throw invalid(pin.error);
  // A delivery needs a written address or a pin on the map (either is enough).
  const deliveryAddress = isDelivery
    ? clean(p.deliveryAddress, 200) || (pin.location ? PINNED_ONLY : '')
    : '';
  if (!customerName) throw invalid('Customer name is required');
  if (isDelivery && !deliveryAddress) throw invalid('Add a delivery address or pin it on the map');
  const channel = p.channel || (isDelivery ? 'phone' : 'walkin');
  if (!CHANNELS.includes(channel)) throw invalid('Invalid channel');
  const method = p.paymentMethod || 'cash';
  if (!['cash', 'mobile_money', 'card'].includes(method))
    throw invalid('Choose cash, mobile money or card');
  // Card is taken on the machine at the counter: never at the door.
  if (method === 'card' && isDelivery)
    throw invalid('Card is taken at the counter for eat-in and pick-up orders only');
  const payLater = !isDelivery && p.payLater === true;
  const rider = isDelivery && p.riderId ? await activeRider(p.riderId) : null;

  // The cashier's branch; the owner may say which branch it is for.
  const branches = require('./branches');
  const branch =
    role === 'admin' && p.branchId
      ? await branches.branchParam(p.branchId)
      : await branches.branchFor(actor);
  const lines = await priceLines(p.items, branch?.id);
  const subtotal = sumBy(lines, (line) => line.lineTotal);
  const fee = isDelivery
    ? Math.max(0, Math.round(Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0))
    : 0;
  const total = subtotal + fee;
  // A customer's voucher (vouchers.js) pays as much of the bill as it can;
  // the rest is paid as chosen.
  const vouchers = require('./vouchers');
  const voucherPhone = p.voucherPhone || p.customerPhone;
  const covered = p.voucherCode ? await vouchers.peek(p.voucherCode, voucherPhone, total) : 0;
  const due = total - covered;
  const momo =
    method === 'mobile_money' && !payLater && due > 0
      ? await checkMobileMoney(
          config,
          p.paymentProvider,
          p.paymentReference,
          undefined,
          p.payerPhone || p.customerPhone,
        )
      : method === 'card' && !payLater && due > 0
        ? await checkCard(config, p.paymentReference)
        : null;

  const me = await actor.fetch(MASTER);
  const order = new Parse.Object('Order');
  if (branch) order.set('branch', branch);
  order.set({
    orderCode: await nextDailyCode('ORD', 4, config.timezone, {
      className: 'Order',
      field: 'orderCode',
    }),
    clientId,
    channel,
    orderType: type,
    source: 'counter',
    placedBy: actor,
    customerName,
    customerPhone: cleanPhone(p.customerPhone),
    deliveryAddress: isDelivery ? deliveryAddress : TYPE_LABEL[type],
    deliveryNotes: clean(isDelivery ? p.deliveryNotes : p.table, 200),
    ...(!isDelivery && clean(p.table, 30) && { tableLabel: clean(p.table, 30) }),
    ...(pin.location && { location: new Parse.GeoPoint(pin.location.lat, pin.location.lng) }),
    subtotal,
    prepMinutes: Math.max(0, ...lines.map((line) => line.prepMinutes)),
    ...splitFields(lines),
    deliveryFee: fee,
    total,
    paymentMethod: method,
    amountToCollect: isDelivery && method === 'cash' ? total : 0,
    amountCollected: 0,
    status: 'PLACED',
    restaurantStatus: 'pending',
    cashStatus: isDelivery && method === 'cash' ? 'NOT_COLLECTED' : 'NOT_APPLICABLE',
    commissionAmount: 0,
    commissionPaid: false,
    disputeFlag: false,
    // The cashier who took it holds it on the kitchen board.
    cashier: me,
    cashierName: personName(me),
    assignedAt: new Date(),
    ...(rider && { createdBy: rider }),
    ...(momo && {
      ...momo.request,
      paymentProvider: momo.provider,
      paymentReference: momo.reference,
      paymentStatus: PENDING,
    }),
  });
  const spent = p.voucherCode
    ? await vouchers.spend(order, p.voucherCode, voucherPhone, actor)
    : null;
  if (spent && isDelivery && method === 'cash') order.set('amountToCollect', due);
  if (spent && !due) vouchers.paidByVoucher(order);
  else if (payLater) order.set({ billOpen: true, cashStatus: 'UNPAID', amountToCollect: due });
  else if (!isDelivery && method === 'cash') await cashIntoTill(order, actor, role);
  order.setACL(readAcl(rider));
  await order.save(null, MASTER);
  if (spent) await spent.save(order);
  await saveLines(order, lines, rider);
  if (isDelivery || order.get('customerPhone')) {
    const customer = await recordCustomerOrder(order);
    if (customer) {
      order.set('customer', customer);
      await order.save(null, MASTER);
    }
  }
  await audit(actor, 'order.placed', order, null, {
    status: 'PLACED',
    total,
    orderType: type,
    source: 'counter',
    riderId: rider?.id || null,
    payment: payLater ? 'later' : method,
  });
  await notifyStaff({
    kind: 'order.new',
    tone: 'new',
    title: `New ${TYPE_LABEL[type].toLowerCase()} order ${order.get('orderCode')}`,
    body: [personName(me), customerName, money(config, total)].join(' · '),
    link: '/cashier',
    order,
    except: actor,
  });
  if (rider) await tellRider(rider, order, config);
  // total: what is left to pay (a voucher may have paid some or all).
  return {
    id: order.id,
    orderCode: order.get('orderCode'),
    total: order.get('total'),
    ...(spent && { voucher: spent.used }),
  };
});

// Cashier/admin: give a call-in delivery to a rider (or another rider),
// until it is picked up.
Parse.Cloud.define('assignOrderRider', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  const order = await new Parse.Query('Order').get(idOf(request.params.orderId) || 'none', MASTER);
  if (order.get('source') !== 'counter' || order.get('orderType') !== 'delivery')
    throw invalid('Only deliveries taken at the counter are assigned here');
  if (!OPEN.includes(order.get('status'))) throw invalid('This order has already left the kitchen');
  const rider = await activeRider(request.params.riderId);
  const before = order.get('createdBy');
  if (before?.id === rider.id) throw invalid('That rider already has this order');
  await assign(order, rider);
  await order.save(null, MASTER);
  await audit(
    actor,
    'order.rider_assigned',
    order,
    { riderId: before?.id || null },
    { riderId: rider.id },
  );
  const { values: config } = await loadConfig();
  await tellRider(rider, order, config);
  if (before)
    await notifyUser(before, {
      kind: 'order.unassigned',
      tone: 'alert',
      title: `${order.get('orderCode')} moved to another rider`,
      body: order.get('customerName'),
      link: '/rider/active',
      order,
    });
  return { riderId: rider.id, rider: personName(rider) };
});

// Cashier/admin: take payment for an open eat-in / pick-up bill.
// params: { orderId, paymentMethod, paymentProvider?, paymentReference? }
Parse.Cloud.define('takeCounterPayment', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  const p = request.params;
  const order = await new Parse.Query('Order').get(idOf(p.orderId) || 'none', MASTER);
  if (!order.get('billOpen')) throw invalid('This bill is already paid');
  if (order.get('status') === 'CANCELLED') throw invalid('This order was cancelled');
  const { values: config } = await loadConfig();
  // The customer's voucher (vouchers.js) pays first; the rest as chosen.
  const vouchers = require('./vouchers');
  const spent = p.voucherCode
    ? await vouchers.spend(
        order,
        p.voucherCode,
        p.voucherPhone || order.get('customerPhone'),
        actor,
      )
    : null;
  if (spent) order.set('amountToCollect', Number(order.get('total') || 0));
  if (spent && !order.get('total')) vouchers.paidByVoucher(order);
  else if (p.paymentMethod === 'cash') await cashIntoTill(order, actor, role);
  else if (p.paymentMethod === 'mobile_money') {
    const momo = await checkMobileMoney(
      config,
      p.paymentProvider,
      p.paymentReference,
      order.id,
      p.payerPhone || order.get('customerPhone'),
    );
    order.set({
      ...momo.request,
      paymentMethod: 'mobile_money',
      paymentProvider: momo.provider,
      paymentReference: momo.reference,
      paymentStatus: PENDING,
      cashStatus: 'NOT_APPLICABLE',
      amountToCollect: 0,
      billOpen: false,
    });
  } else if (p.paymentMethod === 'card') {
    const card = await checkCard(config, p.paymentReference, order.id);
    order.set({
      paymentMethod: 'card',
      paymentProvider: card.provider,
      paymentReference: card.reference,
      paymentStatus: PENDING,
      cashStatus: 'NOT_APPLICABLE',
      amountToCollect: 0,
      billOpen: false,
    });
  } else throw invalid('Choose cash, mobile money or card');
  await order.save(null, MASTER);
  if (spent) await spent.save(order);
  // Served already (eat in): paid in cash, it is finished.
  await require('./orders').closeServed(order, actor);
  await audit(
    actor,
    'payment.counter',
    order,
    { billOpen: true },
    {
      paymentMethod: order.get('paymentMethod'),
      amount: order.get('total'),
    },
  );
  return {
    paymentMethod: order.get('paymentMethod'),
    paymentStatus: order.get('paymentStatus') || null,
  };
});

// Staff: riders who can take a call-in delivery (active riders; those on
// shift and available first). Riders on a break are listed but cannot be
// chosen (activeRider refuses them).
Parse.Cloud.define('getAssignableRiders', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  // A cashier sends riders of their own branch; the owner any rider.
  const branch = role === 'cashier' ? (await user.fetch(MASTER)).get('branch')?.id : null;
  const riderRole = await new Parse.Query(Parse.Role).equalTo('name', 'rider').first(MASTER);
  const riders = riderRole ? await findAll(riderRole.getUsers().query()) : [];
  const shifts = await findAll(
    new Parse.Query('Shift').equalTo('kind', 'rider').equalTo('status', 'open'),
  );
  const onShift = new Set(shifts.map((s) => s.get('operator')?.id));
  return riders
    .filter((rider) => rider.get('active') !== false)
    .filter((rider) => !branch || rider.get('branch')?.id === branch)
    .map((rider) => ({
      id: rider.id,
      name: personName(rider),
      onShift: onShift.has(rider.id),
      available: rider.get('available') !== false,
    }))
    .sort(
      (a, b) =>
        Number(b.onShift && b.available) - Number(a.onShift && a.available) ||
        a.name.localeCompare(b.name),
    );
});

// Staff: what to print for one order (kitchen ticket or customer receipt).
Parse.Cloud.define('getReceipt', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
  const query = new Parse.Query('Order');
  query.include(['createdBy', 'placedBy', 'cashier', 'tillCashier']);
  const order = await query.get(idOf(request.params.orderId) || 'none', MASTER);
  const items = await new Parse.Query('OrderItem').equalTo('order', order).limit(200).find(MASTER);
  const { values: config } = await loadConfig();
  // Tax (EFRIS): a completed sale without its fiscal receipt yet is issued now.
  const efris = require('./efris');
  const fiscal = efris.due(order, config) ? (await efris.issue(order)) || order : order;
  const type = order.get('orderType') || 'delivery';
  const method = order.get('paymentMethod');
  const paid = order.get('billOpen')
    ? 'unpaid'
    : method === 'cash'
      ? ['IN_TILL', 'RECONCILED'].includes(order.get('cashStatus'))
        ? 'paid'
        : 'on_delivery'
      : order.get('paymentStatus') === 'VERIFIED'
        ? 'paid'
        : 'checking';
  return {
    restaurant: config.restaurantName,
    logo: config.restaurantLogo,
    header: config.receiptHeader || '',
    footer: config.receiptFooter || '',
    width: Number(config.receiptWidth) === 58 ? 58 : 80,
    code: order.get('orderCode'),
    type,
    status: order.get('status'),
    table: order.get('tableLabel') || '',
    channel: order.get('channel') || '',
    placedAt: require('./lib/placed').placedAt(order),
    customer: order.get('customerName') || '',
    phone: order.get('customerPhone') || '',
    address: type === 'delivery' ? order.get('deliveryAddress') || '' : '',
    notes: order.get('deliveryNotes') || '',
    rider: order.get('createdBy') ? personName(order.get('createdBy')) : '',
    staff: personName(order.get('tillCashier') || order.get('placedBy') || order.get('cashier')),
    lines: items.map((item) => ({
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
    subtotal: Number(order.get('subtotal') || 0),
    deliveryFee: Number(order.get('deliveryFee') || 0),
    // The full bill; a voucher paid part of it (vouchers.js).
    total: Number(order.get('total') || 0) + Number(order.get('voucherAmount') || 0),
    voucher: order.get('voucherAmount')
      ? {
          code: order.get('voucherCode') || '',
          amount: Number(order.get('voucherAmount')),
          toPay: Number(order.get('total') || 0),
        }
      : null,
    payment: {
      method,
      provider: order.get('paymentProvider') || '',
      reference: order.get('paymentReference') || '',
      state: paid,
      paidAt: order.get('paidAt') || null,
    },
    efris: await efris.receiptView(fiscal, config),
  };
});

module.exports = { modulesOf, COUNTER_TYPES };
