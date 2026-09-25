const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  requireRole,
  isStaff,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
} = require('./lib/core');
const { computeCommission, sumBy } = require('./lib/money');

const CHANNELS = ['walkin', 'phone', 'whatsapp', 'other'];
const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'prepaid'];

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

Parse.Cloud.define('createOrder', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const p = request.params;
  if (!String(p.customerName || '').trim() || !String(p.deliveryAddress || '').trim())
    throw invalid('Customer and address are required');
  if (!Array.isArray(p.items) || !p.items.length) throw invalid('Add at least one item');
  const channel = p.channel || 'walkin';
  const paymentMethod = p.paymentMethod || 'cash';
  if (!CHANNELS.includes(channel)) throw invalid('Invalid channel');
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw invalid('Invalid payment method');

  const activeQuery = new Parse.Query('Order');
  activeQuery.equalTo('createdBy', rider);
  activeQuery.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  const menuQuery = new Parse.Query('MenuItem');
  menuQuery.containedIn(
    'objectId',
    p.items.map((line) => String(line.id)),
  );
  const [savedMenu, { values: config }, activeCount, float] = await Promise.all([
    menuQuery.find(MASTER),
    loadConfig(),
    activeQuery.count(MASTER),
    riderFloat(rider),
  ]);
  if (!config.allowBatching && activeCount)
    throw invalid('Finish your current order before creating another');
  if (config.maxRiderFloat > 0 && float >= config.maxRiderFloat)
    throw invalid('Hand over cash before creating another order');

  const byId = new Map(savedMenu.map((item) => [item.id, item]));
  const lines = p.items.map((line) => {
    const saved = byId.get(String(line.id));
    const qty = Number(line.quantity);
    if (
      !saved ||
      !saved.get('active') ||
      !saved.get('availableToday') ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 50
    )
      throw invalid('Invalid or unavailable item');
    return { name: saved.get('title'), price: Number(saved.get('price')), qty };
  });
  const subtotal = sumBy(lines, (line) => line.price * line.qty);
  const fee = Math.max(0, Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0);
  const total = subtotal + fee;

  const order = new Parse.Object('Order');
  order.set({
    orderCode: await nextDailyCode('ORD', 4, config.timezone),
    channel,
    createdBy: rider,
    customerName: String(p.customerName).trim(),
    customerPhone: String(p.customerPhone || ''),
    deliveryAddress: String(p.deliveryAddress).trim(),
    subtotal,
    deliveryFee: fee,
    total,
    paymentMethod,
    amountCollected: 0,
    status: 'PLACED',
    restaurantStatus: 'pending',
    cashStatus: paymentMethod === 'cash' ? 'NOT_COLLECTED' : 'NOT_APPLICABLE',
    commissionAmount: 0,
    commissionPaid: false,
  });
  order.setACL(readAcl(rider));
  await order.save(null, MASTER);

  const children = lines.map((line) => {
    const item = new Parse.Object('OrderItem');
    item.set({
      order,
      itemNameSnapshot: line.name,
      unitPriceSnapshot: line.price,
      quantity: line.qty,
      lineTotal: line.price * line.qty,
      notes: '',
    });
    item.setACL(readAcl(rider));
    return item;
  });
  await Parse.Object.saveAll(children, MASTER);
  await audit(rider, 'order.placed', order, null, { status: 'PLACED', total });
  return { id: order.id, orderCode: order.get('orderCode'), total };
});

// action → [required status, next status, next restaurantStatus]
const TRANSITIONS = {
  accept: ['PLACED', 'ACCEPTED', 'accepted'],
  prepare: ['ACCEPTED', 'PREPARING', 'preparing'],
  ready: ['PREPARING', 'READY', 'ready'],
  pickup: ['READY', 'PICKED_UP', 'picked_up'],
  deliver: ['PICKED_UP', 'DELIVERED', 'picked_up'],
};

Parse.Cloud.define('transitionOrder', async (request) => {
  const actor = requireUser(request);
  const { action } = request.params;
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  const rule = TRANSITIONS[action];
  if (!rule || order.get('status') !== rule[0]) throw invalid('Invalid status transition');
  const staff = await isStaff(actor);
  if (['accept', 'prepare', 'ready'].includes(action) && !staff)
    throw forbidden('Staff access required');
  if (['pickup', 'deliver'].includes(action) && order.get('createdBy').id !== actor.id && !staff)
    throw forbidden('Not allowed');

  const before = { status: order.get('status'), restaurantStatus: order.get('restaurantStatus') };
  order.set({ status: rule[1], restaurantStatus: rule[2] });
  if (action === 'pickup') order.set('pickedUpAt', new Date());
  if (action === 'deliver') {
    const amount = Number(request.params.amountCollected ?? order.get('total'));
    if (!Number.isFinite(amount) || amount < order.get('total'))
      throw invalid('Collected amount is below total');
    const [rider, { values: config }] = await Promise.all([
      order.get('createdBy').fetch(MASTER),
      loadConfig(),
    ]);
    const isCash = order.get('paymentMethod') === 'cash';
    order.set({
      deliveredAt: new Date(),
      amountCollected: isCash ? amount : 0,
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
  await audit(actor, `order.${action}`, order, before, { status: rule[1] });
  return { status: rule[1] };
});

Parse.Cloud.define('getOperationalMenu', async (request) => {
  requireUser(request);
  const query = new Parse.Query('MenuItem');
  query.equalTo('active', true);
  query.equalTo('availableToday', true);
  query.ascending('sortOrder');
  query.limit(500);
  const [menu, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
  return {
    items: menu.map((item) => ({
      id: item.id,
      title: item.get('title'),
      category: item.get('category') || 'Mains',
      price: item.get('price'),
    })),
    deliveryFee: config.defaultDeliveryFee,
    currencySymbol: config.currencySymbol,
  };
});

module.exports = { riderFloat };
