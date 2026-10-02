// Online ordering: the restaurant's public menu (a link or a QR code on a
// flier) where customers order without signing in, for pick-up or delivery,
// and pay cash on pick-up / delivery or by mobile money.
//
// An online order is a counter order (source 'counter') on the 'online'
// channel, with no cashier yet: it lands in Incoming on the kitchen board,
// the first cashier to act on it takes it, deliveries are given to a rider
// (assignOrderRider; the rider earns the delivery fee only), pick-ups are
// paid at the counter (an open bill) or already paid by mobile money. The
// customer follows it on a tracking page reached with a private token.
//
// Mobile money: with automatic collection on (Admin → Payments) the
// customer's phone gets the payment request; otherwise they pay the
// merchant code and type the transaction ID, which a cashier checks as for
// any order.
//
// The owner switches it on and chooses what is offered in Admin → Online
// orders; cashiers can pause it when the kitchen is full.

const crypto = require('crypto');
const {
  MASTER,
  invalid,
  forbidden,
  requireRole,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
  findAll,
} = require('./lib/core');
const { sumBy } = require('./lib/money');
const { cleanLocation, feeByDistance, pinOf } = require('./lib/geo');
const { merchantAccounts } = require('./lib/mobileMoney');
const { recordCustomerOrder } = require('./customers');
const { checkMobileMoney, PENDING } = require('./payments');
const { money, notifyStaff } = require('./notifications');
const { priceLines, saveLines, splitFields, clean, cleanPhone, PINNED_ONLY } = require('./orders');
const { operationalMenu } = require('./menu');
const { requireAdminUnlock } = require('./adminLock');
const { tableByToken } = require('./tables');

const tenancy = require('./lib/tenant');

const TOKEN = /^[a-f0-9]{32}$/;

// RelayEats Hosted: the public menu is a restaurant's (its own address names
// it: aldea.relayeats.app/order or /order/aldea).
function requireRestaurant() {
  if (!tenancy.current()) throw invalid('Open the restaurant’s own link to order');
}

const DEVICE = /^[a-z0-9-]{8,64}$/;
// How long a phone finds its orders again without their links.
const RECOVER_MS = 6 * 3600000;
const TABLE_RECOVER_MS = 12 * 3600000;

// The phone an order came from, for finding it again when the browser lost
// its saved links (QR scanner apps often open a fresh, private browser):
// a hash of its network address and browser, never the address itself.
function deviceKeyOf(request) {
  const ip = String(request.ip || '');
  const agent = String(request.headers?.['user-agent'] || '');
  if (!ip && !agent) return '';
  return crypto.createHash('sha256').update(`${ip}|${agent}`).digest('hex').slice(0, 40);
}
const deviceOf = (value) => (DEVICE.test(String(value || '')) ? String(value) : '');
const ID = /^[A-Za-z0-9]{1,32}$/;
const TYPE_LABEL = { delivery: 'Delivery', pickup: 'Pick up', eat_in: 'Eat in' };

// What the owner chose (Admin → Online orders).
function onlineSettings(config) {
  const accounts = merchantAccounts(config);
  return {
    enabled: config.onlineOrders === true,
    // Guests at a table order from its QR code (tables.js), paying later.
    tables: config.onlineTables === true,
    open: config.onlineOpen !== false,
    pickup: config.onlinePickup !== false,
    delivery: config.onlineDelivery !== false,
    cash: config.onlineCash !== false,
    mobileMoney: config.onlineMobileMoney !== false && accounts.length > 0,
    note: config.onlineNote || '',
    // Deliveries priced by distance (a rate per km), else the flat fee.
    perKm: Math.max(0, Math.round(Number(config.onlineDeliveryPerKm) || 0)),
    accounts,
  };
}

// The branches a customer can order from (more than one: they choose).
async function openBranches() {
  const rows = await findAll(new Parse.Query('Branch').notEqualTo('active', false));
  return rows
    .sort((a, b) => Number(b.get('main') === true) - Number(a.get('main') === true))
    .map((row) => ({
      id: row.id,
      name: row.get('name') || '',
      address: row.get('address') || '',
      phone: row.get('phone') || '',
      main: row.get('main') === true,
      location: pinOf(row.get('lat'), row.get('lng')),
    }));
}

// Where deliveries leave from: the branch's pin, else the restaurant's.
function originOf(branch, branches, config) {
  const row = branch && branches.find((b) => b.id === branch.id);
  return row?.location || pinOf(config.restaurantLat, config.restaurantLng);
}

// The delivery charge: by distance when a rate per km is set (the customer's
// pin is then needed), else the flat fee from Settings.
function deliveryCharge(s, config, origin, to) {
  if (!s.perKm || !origin)
    return { fee: Math.max(0, Math.round(Number(config.defaultDeliveryFee) || 0)), km: null };
  if (!to) throw invalid('Pin your location on the map, so we can work out the delivery charge');
  return feeByDistance(origin, to, s.perKm);
}

async function branchOf(id, branches) {
  if (!branches.length) return null;
  const wanted = typeof id === 'string' && ID.test(id) ? branches.find((b) => b.id === id) : null;
  const chosen = wanted || branches.find((b) => b.main) || branches[0];
  return Parse.Object.extend('Branch').createWithoutData(chosen.id);
}

// Anyone: the live menu and how to order. { branchId?, table? } (table: the
// token in a table's QR code: that table's branch, eat in, pay later)
Parse.Cloud.define('getOnlineMenu', async (request) => {
  requireRestaurant();
  const { values: config } = await loadConfig();
  const s = onlineSettings(config);
  const restaurant = {
    name: config.restaurantName,
    logo: config.restaurantLogo || null,
    theme: { ink: config.themeInk, accent: config.themeAccent },
    currencySymbol: config.currencySymbol,
    currencyCode: config.currencyCode,
  };
  if (request.params?.table) {
    if (!s.tables) return { enabled: false, restaurant, atTable: true };
    const table = await tableByToken(request.params.table);
    const branches = await openBranches();
    const branch = table.get('branch') || (await branchOf(null, branches));
    const menu = await operationalMenu(branch?.id);
    return {
      enabled: true,
      open: s.open,
      table: { name: table.get('name') },
      note: s.note,
      restaurant,
      branches: [],
      branchId: branch?.id || '',
      categories: menu.categories,
      items: menu.items,
    };
  }
  if (!s.enabled) return { enabled: false, restaurant };
  const branches = await openBranches();
  const branch = await branchOf(request.params?.branchId, branches);
  const menu = await operationalMenu(branch?.id);
  return {
    enabled: true,
    open: s.open,
    pickup: s.pickup,
    delivery: s.delivery,
    cash: s.cash,
    note: s.note,
    // Mobile money: the merchant code to pay, or a request to the phone.
    mobileMoney: s.mobileMoney
      ? s.accounts.map((a) => ({
          provider: a.provider,
          label: a.label,
          code: a.code,
          name: a.name,
          auto: a.auto,
        }))
      : [],
    deliveryFee: Number(config.defaultDeliveryFee) || 0,
    // By distance: the rate and where the branch is (the fee is shown as the
    // customer pins their location; placeOnlineOrder works it out again).
    deliveryPerKm: s.perKm,
    origin: s.perKm ? originOf(branch, branches, config) : null,
    restaurant,
    branches: (branches.length > 1 ? branches : []).map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      phone: b.phone,
      main: b.main,
    })),
    branchId: branch?.id || '',
    categories: menu.categories,
    items: menu.items,
  };
});

// A few orders per address and per phone number in a short time: enough for
// a family, not for someone filling the kitchen board with fake orders.
const recent = new Map();
const WINDOW_MS = 15 * 60000;
function allow(name, limit) {
  const key = `${tenancy.current() || ''}:${name}`;
  const now = Date.now();
  const times = (recent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= limit) return false;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

// Anyone: place an order. { items: [{ id, quantity, accompaniments?, notes? }],
// customerName, customerPhone, orderType: 'pickup' | 'delivery',
// deliveryAddress?, location?, notes?, paymentMethod: 'cash' | 'mobile_money',
// paymentProvider?, paymentReference?, payerPhone?, branchId?, requestId? }
// → { token, orderCode, total }
Parse.Cloud.define('placeOnlineOrder', async (request) => {
  requireRestaurant();
  const p = request.params || {};
  const { values: config } = await loadConfig();
  const s = onlineSettings(config);
  // Ordered at a table (its QR code): eat in, the bill paid later.
  if (p.table && !s.tables) throw forbidden('This restaurant does not take orders from the table');
  const table = p.table ? await tableByToken(p.table) : null;
  if (!table && !s.enabled) throw forbidden('This restaurant does not take online orders');
  if (!s.open)
    throw forbidden('The restaurant is not taking online orders right now. Try again later');

  // The same order sent twice (a lost connection) is placed once.
  const requestId = clean(p.requestId, 64);
  if (requestId) {
    const existing = await new Parse.Query('Order')
      .equalTo('channel', 'online')
      .equalTo('clientId', requestId)
      .first(MASTER);
    if (existing)
      return {
        token: existing.get('onlineToken'),
        orderCode: existing.get('orderCode'),
        total: existing.get('total'),
        duplicate: true,
      };
  }

  const type = table ? 'eat_in' : p.orderType;
  if (!table && (!['pickup', 'delivery'].includes(type) || !s[type]))
    throw invalid(
      s.pickup && s.delivery
        ? 'Choose pick-up or delivery'
        : s.pickup
          ? 'Pick-up only'
          : 'Delivery only',
    );
  const isDelivery = type === 'delivery';
  // At a table the name and number are optional.
  const customerName = clean(p.customerName, 80) || (table ? `${table.get('name')} guest` : '');
  if (!customerName) throw invalid('Enter your name');
  const customerPhone = cleanPhone(p.customerPhone);
  const digits = String(customerPhone).replace(/\D/g, '').length;
  if (table ? digits > 0 && digits < 9 : digits < 9)
    throw invalid('Enter your phone number, so the restaurant can call you');
  const pin = isDelivery ? cleanLocation(p.location) : { location: null };
  if (pin.error) throw invalid(pin.error);
  const deliveryAddress = isDelivery
    ? clean(p.deliveryAddress, 200) || (pin.location ? PINNED_ONLY : '')
    : '';
  if (isDelivery && !deliveryAddress)
    throw invalid('Add your delivery address or pin it on the map');
  // A table's bill is paid at the end (an open bill, like a counter one).
  const method = table ? 'cash' : p.paymentMethod;
  if (!table && (method === 'cash' ? !s.cash : method === 'mobile_money' ? !s.mobileMoney : true))
    throw invalid(
      [s.cash && 'cash', s.mobileMoney && 'mobile money'].filter(Boolean).join(' or ')
        ? `Pay by ${[s.cash && (isDelivery ? 'cash on delivery' : 'cash on pick-up'), s.mobileMoney && 'mobile money'].filter(Boolean).join(' or ')}`
        : 'No way to pay is switched on',
    );

  // Where it leaves from and the delivery charge (a missing pin is a
  // mistake to fix, not an order to count against the limits below).
  const branches = await openBranches();
  const branch = table?.get('branch') || (await branchOf(p.branchId, branches));
  const delivery = isDelivery
    ? deliveryCharge(s, config, originOf(branch, branches, config), pin.location)
    : { fee: 0, km: null };
  const fee = delivery.fee;

  const ip = String(request.ip || '');
  // A table's guests share the restaurant's Wi-Fi: counted per table.
  if (
    table
      ? !allow(`table:${table.id}`, 10)
      : !allow(`ip:${ip}`, 8) || !allow(`phone:${customerPhone}`, 4)
  )
    throw forbidden(
      'Too many orders in a short time. Call the restaurant, or try again in a few minutes',
    );

  const lines = await priceLines(p.items, branch?.id);
  const subtotal = sumBy(lines, (line) => line.lineTotal);
  const total = subtotal + fee;
  const momo =
    method === 'mobile_money'
      ? await checkMobileMoney(
          config,
          p.paymentProvider,
          p.paymentReference,
          undefined,
          p.payerPhone || customerPhone,
        )
      : null;

  const order = new Parse.Object('Order');
  if (branch) order.set('branch', branch);
  order.set({
    orderCode: await nextDailyCode('ORD', 4, config.timezone, {
      className: 'Order',
      field: 'orderCode',
    }),
    clientId: requestId,
    onlineToken: crypto.randomBytes(16).toString('hex'),
    ...(deviceKeyOf(request) && { onlineDeviceKey: deviceKeyOf(request) }),
    ...(deviceOf(p.device) && { onlineDevice: deviceOf(p.device) }),
    channel: table ? 'table' : 'online',
    orderType: type,
    source: 'counter',
    customerName,
    customerPhone,
    deliveryAddress: isDelivery ? deliveryAddress : TYPE_LABEL[type],
    deliveryNotes: clean(p.notes, 200),
    ...(table && { table, tableLabel: table.get('name') }),
    ...(pin.location && { location: new Parse.GeoPoint(pin.location.lat, pin.location.lng) }),
    subtotal,
    prepMinutes: Math.max(0, ...lines.map((line) => line.prepMinutes)),
    ...splitFields(lines),
    deliveryFee: fee,
    ...(delivery.km !== null && { deliveryKm: delivery.km }),
    total,
    paymentMethod: method,
    amountToCollect: method === 'cash' ? total : 0,
    amountCollected: 0,
    status: 'PLACED',
    restaurantStatus: 'pending',
    cashStatus: method === 'cash' ? (isDelivery ? 'NOT_COLLECTED' : 'UNPAID') : 'NOT_APPLICABLE',
    // A pick-up paid in cash is an open bill, paid at the counter.
    ...(method === 'cash' && !isDelivery && { billOpen: true }),
    commissionAmount: 0,
    commissionPaid: false,
    disputeFlag: false,
    ...(momo && {
      ...momo.request,
      paymentProvider: momo.provider,
      paymentReference: momo.reference,
      paymentStatus: PENDING,
    }),
  });
  order.setACL(readAcl(null));
  await order.save(null, MASTER);
  await saveLines(order, lines, null);
  const customer = await recordCustomerOrder(order);
  if (customer) {
    order.set('customer', customer);
    await order.save(null, MASTER);
  }
  await audit(null, 'order.placed', order, null, {
    status: 'PLACED',
    total,
    orderType: type,
    source: table ? 'table' : 'online',
    payment: table ? 'later' : method,
    ...(table && { table: table.get('name') }),
  });
  await notifyStaff({
    kind: 'order.new',
    tone: 'new',
    title: table
      ? `New order ${order.get('orderCode')} at ${table.get('name')}`
      : `New online ${type === 'delivery' ? 'delivery' : 'pick-up'} ${order.get('orderCode')}`,
    body: [customerName, customerPhone, money(config, total)].join(' · '),
    link: '/cashier',
    order,
  });
  return { token: order.get('onlineToken'), orderCode: order.get('orderCode'), total };
});

// Still going: not cancelled, and not finished unless its bill is open.
const stillOpen = (order) =>
  order.get('status') !== 'CANCELLED' &&
  (order.get('status') !== 'DELIVERED' || order.get('billOpen') === true);

// Anyone: this phone's orders still going, found again after the browser
// lost their links, and at a table, the orders still open at it. Only
// orders of the last few hours. { device?, table? }
// (device: the phone's own id, when it still has one: then orders from
// other phones that look the same on the same network are left out)
Parse.Cloud.define('getMyOnlineOrders', async (request) => {
  requireRestaurant();
  const p = request.params || {};
  const now = Date.now();
  const found = [];
  const key = deviceKeyOf(request);
  if (key) {
    const device = deviceOf(p.device);
    const rows = await new Parse.Query('Order')
      .equalTo('onlineDeviceKey', key)
      .greaterThan('createdAt', new Date(now - RECOVER_MS))
      .descending('createdAt')
      .limit(10)
      .find(MASTER);
    found.push(
      ...rows.filter((o) => !device || !o.get('onlineDevice') || o.get('onlineDevice') === device),
    );
  }
  if (p.table) {
    const table = await tableByToken(p.table).catch(() => null);
    if (table)
      found.push(
        ...(await new Parse.Query('Order')
          .equalTo('table', table)
          .greaterThan('createdAt', new Date(now - TABLE_RECOVER_MS))
          .descending('createdAt')
          .limit(20)
          .find(MASTER)),
      );
  }
  const seen = new Set();
  return {
    orders: found
      .filter((o) => o.get('onlineToken') && stillOpen(o))
      .filter((o) => !seen.has(o.id) && seen.add(o.id))
      .map((o) => ({
        token: o.get('onlineToken'),
        orderCode: o.get('orderCode'),
        placedAt: o.createdAt.toISOString(),
      })),
  };
});

async function orderByToken(token) {
  requireRestaurant();
  const value = String(token || '');
  if (!TOKEN.test(value)) throw invalid('Order not found');
  const order = await new Parse.Query('Order').equalTo('onlineToken', value).first(MASTER);
  if (!order) throw invalid('Order not found');
  return order;
}

// Anyone with the order's link: where it is. { token }
Parse.Cloud.define('getOnlineOrder', async (request) => {
  let order = await orderByToken(request.params?.token);
  // A payment request still open: ask the provider (at most every few seconds).
  if (order.get('payRequestStatus') === 'pending') {
    await require('./collections').pollRequest(order);
    order = await orderByToken(request.params?.token);
  }
  const items = await new Parse.Query('OrderItem').equalTo('order', order).limit(100).find(MASTER);
  const { values: config } = await loadConfig();
  return {
    orderCode: order.get('orderCode'),
    status: order.get('status'),
    orderType: order.get('orderType'),
    customerName: order.get('customerName'),
    deliveryAddress: order.get('orderType') === 'delivery' ? order.get('deliveryAddress') : '',
    table: order.get('orderType') === 'eat_in' ? order.get('tableLabel') || '' : '',
    billOpen: order.get('billOpen') === true,
    served: !!order.get('servedAt'),
    subtotal: Number(order.get('subtotal') || 0),
    deliveryFee: Number(order.get('deliveryFee') || 0),
    deliveryKm: order.get('deliveryKm') ?? null,
    total: Number(order.get('total') || 0),
    paymentMethod: order.get('paymentMethod'),
    paymentStatus: order.get('paymentStatus') || '',
    paymentProvider: order.get('paymentProvider') || '',
    payRequestStatus: order.get('payRequestStatus') || '',
    paid: order.get('billOpen') !== true && order.get('cashStatus') === 'IN_TILL',
    cancelReason: order.get('status') === 'CANCELLED' ? order.get('cancelReason') || '' : '',
    placedAt: order.createdAt.toISOString(),
    lines: items.map((item) => ({
      name: item.get('itemNameSnapshot'),
      quantity: Number(item.get('quantity') || 0),
      sides: item.get('accompanimentNames') || [],
      total: Number(item.get('lineTotal') || 0),
    })),
    restaurant: {
      name: config.restaurantName,
      logo: config.restaurantLogo || null,
      currencySymbol: config.currencySymbol,
    },
  };
});

// Anyone with the order's link: cancel it while the kitchen has not started
// and nothing has been paid. { token }
Parse.Cloud.define('cancelOnlineOrder', async (request) => {
  const order = await orderByToken(request.params?.token);
  if (order.get('status') !== 'PLACED' || order.get('cashier'))
    throw forbidden('The restaurant has started on this order. Call them to change it');
  if (order.get('paymentStatus') === 'VERIFIED')
    throw forbidden('This order is paid. Call the restaurant to cancel it');
  const before = { status: order.get('status') };
  order.set({
    status: 'CANCELLED',
    cancelReason: 'Cancelled by the customer',
    cancelledAt: new Date(),
    billOpen: false,
    amountToCollect: 0,
    cashStatus: 'NOT_APPLICABLE',
  });
  if (order.get('payRequestStatus') === 'pending') order.set('payRequestStatus', 'closed');
  await order.save(null, MASTER);
  await audit(null, 'order.cancelled', order, before, {
    status: 'CANCELLED',
    by: 'customer',
  });
  const { values: config } = await loadConfig();
  await notifyStaff({
    kind: 'order.cancelled',
    tone: 'alert',
    title: `Online order ${order.get('orderCode')} cancelled by the customer`,
    body: [order.get('customerName'), money(config, order.get('total'))].join(' · '),
    link: '/cashier',
    order,
  });
  return { status: 'CANCELLED' };
});

// Owner: switch online orders on and choose what is offered.
// { onlineOrders, onlinePickup, onlineDelivery, onlineCash, onlineMobileMoney,
//   onlineNote, onlineOpen }
Parse.Cloud.define('adminSaveOnlineOrdering', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const { object: existing, values: current } = await loadConfig();
  if (!existing) throw invalid('Save the restaurant settings first');
  const before = Object.fromEntries(
    [
      'onlineOrders',
      'onlineOpen',
      'onlinePickup',
      'onlineDelivery',
      'onlineCash',
      'onlineMobileMoney',
      'onlineNote',
      'onlineDeliveryPerKm',
      'onlineTables',
    ].map((key) => [key, current[key]]),
  );
  const flag = (key, fallback) => (key in p ? p[key] === true : fallback);
  const next = {
    onlineOrders: flag('onlineOrders', current.onlineOrders === true),
    onlineTables: flag('onlineTables', current.onlineTables === true),
    onlineOpen: flag('onlineOpen', current.onlineOpen !== false),
    onlinePickup: flag('onlinePickup', current.onlinePickup !== false),
    onlineDelivery: flag('onlineDelivery', current.onlineDelivery !== false),
    onlineCash: flag('onlineCash', current.onlineCash !== false),
    onlineMobileMoney: flag('onlineMobileMoney', current.onlineMobileMoney !== false),
    onlineNote: clean('onlineNote' in p ? p.onlineNote : current.onlineNote, 200),
    onlineDeliveryPerKm:
      'onlineDeliveryPerKm' in p
        ? Number(p.onlineDeliveryPerKm)
        : Number(current.onlineDeliveryPerKm) || 0,
  };
  if (
    !Number.isFinite(next.onlineDeliveryPerKm) ||
    next.onlineDeliveryPerKm < 0 ||
    next.onlineDeliveryPerKm > 1e7
  )
    throw invalid('The delivery charge per km must be 0 or more');
  next.onlineDeliveryPerKm = Math.round(next.onlineDeliveryPerKm);
  if (next.onlineOrders && !next.onlinePickup && !next.onlineDelivery)
    throw invalid('Offer pick-up, delivery or both');
  if (
    next.onlineOrders &&
    !next.onlineCash &&
    !(next.onlineMobileMoney && merchantAccounts(current).length)
  )
    throw invalid('Let customers pay cash, or set up mobile money in Settings first');
  existing.set(next);
  await existing.save(null, MASTER);
  await audit(actor, 'online.settings_saved', existing, before, next);
  return onlineView({ ...current, ...next });
});

// Cashier or owner: pause online orders when the kitchen is full, or reopen.
// { open }
Parse.Cloud.define('setOnlineOpen', async (request) => {
  const { user } = await requireRole(request, ['cashier', 'admin']);
  const { object: existing, values: current } = await loadConfig();
  if (!existing || (current.onlineOrders !== true && current.onlineTables !== true))
    throw invalid('Online orders are not switched on');
  const open = request.params?.open === true;
  existing.set('onlineOpen', open);
  await existing.save(null, MASTER);
  await audit(user, open ? 'online.opened' : 'online.paused', existing, null, { open });
  return { open };
});

// The owner's view of the settings.
function onlineView(config) {
  const s = onlineSettings(config);
  return {
    onlineOrders: s.enabled,
    onlineOpen: s.open,
    onlinePickup: s.pickup,
    onlineDelivery: s.delivery,
    onlineCash: s.cash,
    onlineMobileMoney: config.onlineMobileMoney !== false,
    mobileMoneyReady: s.accounts.length > 0,
    onlineNote: s.note,
    onlineDeliveryPerKm: s.perKm,
    onlineTables: s.tables,
  };
}

Parse.Cloud.define('adminGetOnlineOrdering', async (request) => {
  await requireAdminUnlock(request);
  const { values: config } = await loadConfig();
  return {
    ...onlineView(config),
    restaurantName: config.restaurantName,
    restaurantLogo: config.restaurantLogo || null,
  };
});

module.exports = { onlineSettings };
