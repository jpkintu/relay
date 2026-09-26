// People: PIN changes and resets, rider availability, and the owner's page
// for one team member (cash held, open orders, lifetime figures, handovers,
// pay and shifts).

const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  requireRole,
  adminOnly,
  getRoleName,
  audit,
  loadConfig,
  riderFloat,
  verifyPin,
  withRiderLimit,
  endSessions,
} = require('./lib/core');
const { orderRiderPay } = require('./lib/money');
const { riderOutstanding } = require('./shifts');
const { riderPayState, payoutJSON } = require('./payouts');
const { handoverJSON } = require('./cash');

const STAFF_ROLES = ['rider', 'cashier'];

// Riders and cashiers sign in with a PIN of 4 to 32 characters; the owner's
// password needs at least 8.
function checkNewPin(role, pin) {
  const [min, max] = role === 'admin' ? [8, 64] : [4, 32];
  if (pin.length < min || pin.length > max)
    throw invalid(
      role === 'admin'
        ? 'Choose a password of 8 to 64 characters'
        : 'Choose a PIN of 4 to 32 characters',
    );
}

// Anyone: change their own PIN (or the owner's password). The old PIN is
// checked with the same five-try lock as other sensitive steps. Every device
// is signed out; the app signs straight back in with the new PIN.
Parse.Cloud.define('changeMyPin', async (request) => {
  const user = requireUser(request);
  const role = await getRoleName(user);
  const next = String(request.params.newPin ?? '');
  checkNewPin(role, next);
  if (next === String(request.params.oldPin ?? ''))
    throw invalid('The new PIN must be different from the old one');
  await verifyPin(user, request.params.oldPin);
  const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER);
  fresh.set('password', next);
  await fresh.save(null, MASTER);
  const signedOut = await endSessions(fresh);
  await audit(user, 'team.pin_changed', fresh, null, { by: 'self', signedOut });
  return { ok: true };
});

// Rider: available for orders, or on a break (new orders are refused).
// Starting a shift makes the rider available again.
Parse.Cloud.define('setMyAvailability', async (request) => {
  const { user } = await requireRole(request, ['rider']);
  const available = request.params.available === true;
  const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER);
  const before = fresh.get('available') !== false;
  if (before !== available) {
    fresh.set('available', available);
    await fresh.save(null, MASTER);
    await audit(user, 'rider.availability', fresh, { available: before }, { available });
  }
  return { available };
});

// Owner: set a new PIN for a rider or cashier who forgot theirs. Clears any
// PIN lock and signs them out of every device.
Parse.Cloud.define('adminResetPin', async (request) => {
  const actor = await adminOnly(request);
  const user = await new Parse.Query(Parse.User).get(String(request.params.id || ''), MASTER);
  if (user.id === actor.id) throw forbidden('Change your own password from your profile');
  const role = await getRoleName(user);
  if (!STAFF_ROLES.includes(role)) throw forbidden('Only rider and cashier PINs can be reset here');
  const pin = String(request.params.pin ?? '');
  checkNewPin(role, pin);
  user.set({ password: pin, pinFailures: 0 });
  user.unset('pinLockedUntil');
  await user.save(null, MASTER);
  const signedOut = await endSessions(user);
  await audit(actor, 'team.pin_reset', user, null, { signedOut });
  return { ok: true, signedOut };
});

const openOrderJSON = (order) => ({
  id: order.id,
  code: order.get('orderCode'),
  status: order.get('status'),
  customer: order.get('customerName') || '',
  total: Number(order.get('total') || 0),
  paymentMethod: order.get('paymentMethod'),
  createdAt: order.createdAt,
});

// Every delivered and cancelled order the rider has had, summed.
async function riderLifetime(rider) {
  const query = new Parse.Query('Order');
  query.equalTo('createdBy', rider);
  query.containedIn('status', ['DELIVERED', 'CANCELLED']);
  query.select(
    'status',
    'total',
    'commissionAmount',
    'deliveryPay',
    'deliveryFee',
    'deliveredAt',
    'paymentMethod',
  );
  const stats = {
    deliveries: 0,
    cancelled: 0,
    sales: 0,
    riderPay: 0,
    cashSales: 0,
    firstDelivery: null,
    lastDelivery: null,
  };
  await query.each((order) => {
    if (order.get('status') === 'CANCELLED') {
      stats.cancelled += 1;
      return;
    }
    const total = Number(order.get('total')) || 0;
    stats.deliveries += 1;
    stats.sales += total;
    stats.riderPay += orderRiderPay(order);
    if (order.get('paymentMethod') === 'cash') stats.cashSales += total;
    const at = order.get('deliveredAt');
    if (at && (!stats.firstDelivery || at < stats.firstDelivery)) stats.firstDelivery = at;
    if (at && (!stats.lastDelivery || at > stats.lastDelivery)) stats.lastDelivery = at;
  }, MASTER);
  return stats;
}

async function riderDetail(rider, config) {
  const openQuery = new Parse.Query('Order');
  openQuery.equalTo('createdBy', rider);
  openQuery.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  openQuery.descending('createdAt');
  openQuery.limit(50);
  const handoverQuery = new Parse.Query('CashHandover');
  handoverQuery.equalTo('rider', rider);
  handoverQuery.descending('handedOverAt');
  handoverQuery.limit(15);
  const payoutQuery = new Parse.Query('TillPayout');
  payoutQuery.equalTo('rider', rider);
  payoutQuery.include(['rider', 'paidBy']);
  payoutQuery.descending('paidAt');
  payoutQuery.limit(15);
  const [float, outstanding, open, lifetime, pay, handovers, payouts] = await Promise.all([
    riderFloat(rider),
    riderOutstanding(rider),
    openQuery.find(MASTER),
    riderLifetime(rider),
    riderPayState(rider),
    handoverQuery.find(MASTER),
    payoutQuery.find(MASTER),
  ]);
  const limit = withRiderLimit(config, rider).maxRiderFloat;
  return {
    cash: {
      held: float,
      withRider: outstanding.cashWithRider,
      pending: outstanding.cashPending,
      momoPending: outstanding.momoPending,
      limit,
    },
    openOrders: open.map(openOrderJSON),
    lifetime,
    pay: {
      owed: pay.owed,
      earned: pay.earned,
      deliveryFees: pay.deliveryFees,
      deductions: pay.deductions,
      deliveries: pay.orders.length,
    },
    handovers: handovers.map(handoverJSON),
    payouts: payouts.map(payoutJSON),
  };
}

async function cashierDetail(cashier) {
  const shiftQuery = new Parse.Query('Shift');
  shiftQuery.equalTo('operator', cashier);
  shiftQuery.equalTo('kind', 'cashier');
  shiftQuery.descending('startedAt');
  shiftQuery.limit(15);
  const heldQuery = new Parse.Query('Order');
  heldQuery.equalTo('cashier', cashier);
  heldQuery.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  heldQuery.descending('createdAt');
  heldQuery.limit(50);
  const [shifts, held] = await Promise.all([shiftQuery.find(MASTER), heldQuery.find(MASTER)]);
  return {
    heldOrders: held.map(openOrderJSON),
    shifts: shifts.map((row) => ({
      id: row.id,
      status: row.get('status'),
      startedAt: row.get('startedAt'),
      endedAt: row.get('endedAt') || null,
      openingFloat: Number(row.get('openingFloat') || 0),
      cashIn: row.get('cashIn') ?? null,
      paidOut: row.get('paidOut') ?? null,
      expectedTill: row.get('expectedTill') ?? null,
      physicalCount: row.get('physicalCount') ?? null,
      variance: row.get('variance') ?? null,
      varianceNote: row.get('varianceNote') || '',
    })),
  };
}

// Owner: one team member's page.
Parse.Cloud.define('adminGetMember', async (request) => {
  await adminOnly(request);
  const user = await new Parse.Query(Parse.User).get(String(request.params.id || ''), MASTER);
  const [role, { values: config }] = await Promise.all([getRoleName(user), loadConfig()]);
  const shift = await new Parse.Query('Shift')
    .equalTo('operator', user)
    .equalTo('status', 'open')
    .first(MASTER);
  const lockedUntil = user.get('pinLockedUntil');
  const own = user.get('maxFloat');
  return {
    id: user.id,
    name: user.get('name') || user.getUsername(),
    username: user.getUsername(),
    phone: user.get('phone') || '',
    role: role || 'unassigned',
    code: user.get('riderCode') || user.get('cashierCode') || '',
    active: user.get('active') !== false,
    available: role === 'rider' ? user.get('available') !== false : null,
    pinLocked: !!(lockedUntil && lockedUntil > new Date()),
    joinedAt: user.createdAt,
    onShiftSince: shift ? shift.get('startedAt') : null,
    commission: {
      type: user.get('commissionType') || 'per_order',
      perOrder: user.get('commissionPerOrder') || 0,
      percent: user.get('commissionPercent') || 0,
    },
    cashLimit: typeof own === 'number' ? own : null,
    defaultCashLimit: config.maxRiderFloat,
    rider: role === 'rider' ? await riderDetail(user, config) : null,
    cashier: role === 'cashier' ? await cashierDetail(user) : null,
  };
});

module.exports = { checkNewPin };
