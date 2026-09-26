const {
  MASTER,
  invalid,
  requireRole,
  adminOnly,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
  requireCashierShift,
  claimOnce,
  verifyPin,
  personName,
} = require('./lib/core');
const { sumBy } = require('./lib/money');
const { money, notifyUser, notifyStaff, notifyAdmins } = require('./notifications');
const { payOut } = require('./payouts');

// A handover waiting this long for the cashier is flagged to staff and owner.
const STALE_HOURS = 4;

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

// Each order can join one handover per "round"; the round moves on when the
// cash is returned to the rider, so it can be handed over again later.
const handoverKey = (order) => `handover-order:${order.id}:${order.get('handoverRound') || 0}`;
// One cashier reviews a handover per round; reopening starts a new round.
const reviewKey = (row) => `handover-review:${row.id}:${row.get('reviewRound') || 0}`;

// Moves the round on for orders we claimed but could not use, so the rider
// can try again. Only the counter field is sent, never a stale status.
async function releaseOrders(orders) {
  await Promise.all(
    orders.map((order) => {
      const ref = new Parse.Object('Order');
      ref.id = order.id;
      ref.increment('handoverRound');
      return ref.save(null, MASTER);
    }),
  );
}

async function newHandover({ rider, orders, config, notes, requestId, cashier }) {
  const row = new Parse.Object('CashHandover');
  row.set({
    handoverCode: await nextDailyCode('HO', 3, config.timezone, {
      className: 'CashHandover',
      field: 'handoverCode',
    }),
    rider,
    amount: sumBy(orders, (order) => order.get('amountCollected')),
    orderCount: orders.length,
    orders,
    status: 'pending',
    handedOverAt: new Date(),
    notes: clean(notes, 200),
    requestId: requestId || '',
    reviewRound: 0,
    ...(cashier && { cashier }),
  });
  row.setACL(readAcl(rider));
  return row;
}

// Claims every order for this handover or none of them. Orders are claimed
// one at a time in a fixed order, so when two requests race for the same
// orders the one that loses the first order stops there and the other gets
// them all (claiming in parallel could leave each with half and both fail).
async function claimOrders(orders) {
  const sorted = [...orders].sort((a, b) => (a.id < b.id ? -1 : 1));
  const claimed = [];
  for (const order of sorted) {
    if (!(await claimOnce(handoverKey(order)))) {
      await releaseOrders(claimed);
      throw invalid('Some of these orders are already being handed over. Refresh and try again');
    }
    claimed.push(order);
  }
}

Parse.Cloud.define('createHandover', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const p = request.params;
  const ids = p.orderIds;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw invalid('Select unique orders');
  // A retried request (lost connection) returns the handover already made.
  const requestId = clean(p.requestId, 64);
  if (requestId) {
    const existing = await new Parse.Query('CashHandover')
      .equalTo('rider', rider)
      .equalTo('requestId', requestId)
      .first(MASTER);
    if (existing) return { id: existing.id, amount: existing.get('amount'), duplicate: true };
  }
  await verifyPin(rider, p.pin);
  const query = new Parse.Query('Order');
  query.containedIn('objectId', ids);
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.equalTo('cashStatus', 'WITH_RIDER');
  const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
  if (orders.length !== ids.length) throw invalid('Invalid handover orders');
  await claimOrders(orders);

  const row = await newHandover({ rider, orders, config, notes: p.notes, requestId });
  await row.save(null, MASTER);
  orders.forEach((order) => order.set('cashStatus', 'HANDOVER_PENDING'));
  await Parse.Object.saveAll(orders, MASTER);
  const amount = row.get('amount');
  await audit(rider, 'cash.handover_created', row, null, { amount });
  await notifyStaff({
    kind: 'cash.handover',
    tone: 'new',
    title: `Cash handover ${row.get('handoverCode')}`,
    body: `${personName(rider)} · ${money(config, amount)} · ${orders.length} ${
      orders.length === 1 ? 'order' : 'orders'
    }`,
    link: '/cashier/handovers',
  });
  return { id: row.id, amount };
});

// Takes the review of a pending handover for this cashier, or explains who
// has it.
async function startReview(row) {
  if (row.get('status') !== 'pending') throw invalid('This handover was already dealt with');
  if (!(await claimOnce(reviewKey(row))))
    throw invalid('Another cashier is already counting this handover');
}

async function loadOrders(row) {
  return Promise.all((row.get('orders') || []).map((ptr) => ptr.fetch(MASTER)));
}

// The cashier counts the cash and ticks the orders it covers. Orders not
// ticked go back to the rider to hand over again; the count must match the
// ticked orders exactly (a missing amount is a dispute instead).
Parse.Cloud.define('confirmHandover', async (request) => {
  const { user: cashier, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(cashier, role);
  const p = request.params;
  const row = await new Parse.Query('CashHandover').get(p.handoverId, MASTER);
  const orders = await loadOrders(row);
  const receivedIds = Array.isArray(p.receivedOrderIds)
    ? p.receivedOrderIds.map(String)
    : orders.map((order) => order.id);
  const received = orders.filter((order) => receivedIds.includes(order.id));
  const returned = orders.filter((order) => !receivedIds.includes(order.id));
  if (!received.length) throw invalid('Tick at least one order you received cash for');
  if (received.length !== new Set(receivedIds).size)
    throw invalid('Those orders are not in this handover');
  const due = sumBy(received, (order) => order.get('amountCollected'));
  const counted = Number(p.countedAmount);
  if (!Number.isFinite(counted) || counted !== due)
    throw invalid('Counted cash must match the ticked orders; dispute any missing cash');
  if (orders.some((order) => order.get('cashStatus') !== 'HANDOVER_PENDING'))
    throw invalid('Orders are no longer pending this handover');
  // "Pay the rider now": their pay for these orders comes out of the till as
  // a payout, so it needs the PIN like any other payout.
  const payNow = p.payRider === true;
  if (payNow) await verifyPin(cashier, p.pin);
  await startReview(row);

  const now = new Date();
  received.forEach((order) => order.set({ cashStatus: 'RECONCILED', settledAt: now }));
  returned.forEach((order) =>
    order.set({
      cashStatus: 'WITH_RIDER',
      handoverRound: Number(order.get('handoverRound') || 0) + 1,
    }),
  );
  await Parse.Object.saveAll(orders, MASTER);
  row.set({
    status: 'confirmed',
    cashier,
    confirmedAt: now,
    tillAt: now,
    countedAmount: counted,
    returnedOrders: returned,
    returnedAmount: sumBy(returned, (order) => order.get('amountCollected')),
  });
  await row.save(null, MASTER);
  await audit(
    cashier,
    'cash.handover_confirmed',
    row,
    { status: 'pending', amount: row.get('amount') },
    { status: 'confirmed', countedAmount: counted, returned: returned.map((o) => o.id) },
  );
  const { values: config } = await loadConfig();
  const by = personName(await cashier.fetch(MASTER));
  await notifyUser(row.get('rider'), {
    kind: 'cash.handover_confirmed',
    tone: returned.length ? 'alert' : 'update',
    title: `Handover ${row.get('handoverCode')} confirmed`,
    body: returned.length
      ? `${money(config, counted)} received by ${by}. ${returned.length} ${
          returned.length === 1 ? 'order was' : 'orders were'
        } not received (${money(config, row.get('returnedAmount'))}) and ${
          returned.length === 1 ? 'is' : 'are'
        } back with you: hand ${returned.length === 1 ? 'it' : 'them'} over again.`
      : `${money(config, counted)} received by ${by}.`,
    link: '/rider/cash',
  });
  let paid = 0;
  let payProblem = '';
  if (payNow) {
    try {
      const rider = await new Parse.Query(Parse.User).get(row.get('rider').id, MASTER);
      // Only the delivery fees are paid at the handover; commission comes later.
      paid = (
        await payOut({
          actor: cashier,
          role,
          rider,
          orderIds: received.map((o) => o.id),
          feesOnly: true,
        })
      ).amount;
    } catch (error) {
      // The cash is confirmed either way; the pay can be made from Payouts.
      payProblem = error.message;
    }
  }
  return { status: 'confirmed', returned: returned.length, paid, payProblem };
});

// The count is short: the cashier keeps what they counted and the owner
// decides what happens to the difference.
Parse.Cloud.define('disputeHandover', async (request) => {
  const { user: cashier, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(cashier, role);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, MASTER);
  const reason = clean(request.params.reason, 300);
  const counted = Number(request.params.countedAmount);
  if (reason.length < 5 || !Number.isFinite(counted) || counted < 0)
    throw invalid('Enter a reason and physical cash count');
  if (counted >= Number(row.get('amount')))
    throw invalid('The count matches the claim: confirm the handover instead');
  await startReview(row);
  const now = new Date();
  row.set({
    status: 'disputed',
    cashier,
    disputeReason: reason,
    countedAmount: counted,
    disputedAt: now,
    tillAt: now,
  });
  await row.save(null, MASTER);
  await audit(
    cashier,
    'cash.handover_disputed',
    row,
    { status: 'pending', amount: row.get('amount') },
    { status: 'disputed', countedAmount: counted, reason },
  );
  const { values: config } = await loadConfig();
  const disputed = {
    kind: 'cash.handover_disputed',
    tone: 'alert',
    title: `Handover ${row.get('handoverCode')} disputed`,
    body: `Counted ${money(config, counted)} of ${money(config, row.get('amount'))}: ${reason}`,
  };
  await notifyUser(row.get('rider'), { ...disputed, link: '/rider/cash' });
  await notifyAdmins({ ...disputed, link: '/admin/payments', except: cashier });
  return { status: 'disputed' };
});

const RESOLUTIONS = ['write_off', 'deduct', 'reopen'];

// Owner decides a disputed handover:
// - write_off: accept the counted cash, the restaurant absorbs the shortage;
// - deduct: accept the counted cash, the shortage comes off the rider's pay;
// - reopen: send it back to the cashiers to count again.
Parse.Cloud.define('adminResolveHandover', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  if (!RESOLUTIONS.includes(p.action)) throw invalid('Choose how to resolve it');
  const row = await new Parse.Query('CashHandover').get(p.handoverId, MASTER);
  if (row.get('status') !== 'disputed') throw invalid('Only disputed handovers can be resolved');
  const note = clean(p.note, 300);
  if (note.length < 5) throw invalid('Enter a resolution note');
  const shortage = Math.max(0, Number(row.get('amount')) - Number(row.get('countedAmount') || 0));
  const now = new Date();
  const base = { resolutionNote: note, resolvedBy: actor, resolvedAt: now, resolution: p.action };
  if (p.action === 'reopen') {
    // The cashier counts it again; that count is what enters the till.
    if (row.has('tillAt')) row.unset('tillAt');
    row.set({
      ...base,
      status: 'pending',
      reviewRound: Number(row.get('reviewRound') || 0) + 1,
    });
  } else {
    const orders = await loadOrders(row);
    orders.forEach((order) => order.set({ cashStatus: 'RECONCILED', settledAt: now }));
    await Parse.Object.saveAll(orders, MASTER);
    row.set({
      ...base,
      status: 'confirmed',
      confirmedAt: now,
      shortage,
      shortageStatus: p.action === 'deduct' ? 'owed' : 'written_off',
    });
  }
  await row.save(null, MASTER);
  await audit(
    actor,
    `cash.dispute_${p.action}`,
    row,
    { status: 'disputed', reason: row.get('disputeReason') },
    { status: row.get('status'), shortage, note },
  );
  const { values: config } = await loadConfig();
  const messages = {
    write_off: `Resolved: the ${money(config, shortage)} shortage was written off.`,
    deduct: `Resolved: the ${money(config, shortage)} shortage will come off your next pay.`,
    reopen: 'The cashier will count it again.',
  };
  await notifyUser(row.get('rider'), {
    kind: 'cash.dispute_resolved',
    tone: 'update',
    title: `Handover ${row.get('handoverCode')}`,
    body: `${messages[p.action]} ${note}`,
    link: '/rider/cash',
  });
  if (p.action === 'reopen') await notifyStaffAbout(row, 'reopened for counting again', config);
  return { status: row.get('status'), shortage };
});

// Kept for older app versions: the same as resolving with "reopen".
Parse.Cloud.define('reopenHandover', async (request) => {
  const actor = await adminOnly(request);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, MASTER);
  if (row.get('status') !== 'disputed') throw invalid('Only disputed handovers can be reopened');
  const note = clean(request.params.note, 300);
  if (note.length < 5) throw invalid('Enter a resolution note');
  row.set({
    status: 'pending',
    resolutionNote: note,
    resolvedBy: actor,
    resolvedAt: new Date(),
    resolution: 'reopen',
    reviewRound: Number(row.get('reviewRound') || 0) + 1,
  });
  if (row.has('tillAt')) row.unset('tillAt');
  await row.save(null, MASTER);
  await audit(actor, 'cash.dispute_reopened', row, { status: 'disputed' }, { status: 'pending' });
  return { status: 'pending' };
});

async function notifyStaffAbout(row, what, config) {
  await notifyStaff({
    kind: 'cash.handover',
    tone: 'alert',
    title: `Handover ${row.get('handoverCode')} ${what}`,
    body: `${personName(await row.get('rider').fetch(MASTER))} · ${money(config, row.get('amount'))}`,
    link: '/cashier/handovers',
  });
}

// Owner takes a rider's cash in person (e.g. the rider cannot come to the
// counter). Recorded as a confirmed handover received by the owner; it is
// not part of any cashier's till.
Parse.Cloud.define('adminReceiveCash', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  const note = clean(p.note, 200);
  if (note.length < 5) throw invalid('Say where the cash is (e.g. "Owner took it to the bank")');
  const rider = await new Parse.Query(Parse.User).get(String(p.riderId), MASTER);
  const query = new Parse.Query('Order');
  query.equalTo('createdBy', rider);
  query.equalTo('status', 'DELIVERED');
  query.equalTo('cashStatus', 'WITH_RIDER');
  if (Array.isArray(p.orderIds)) query.containedIn('objectId', p.orderIds.map(String));
  query.limit(500);
  const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
  if (!orders.length) throw invalid('This rider holds no cash to receive');
  await claimOrders(orders);
  const row = await newHandover({ rider, orders, config, notes: note, cashier: actor });
  const now = new Date();
  row.set({
    status: 'confirmed',
    confirmedAt: now,
    countedAmount: row.get('amount'),
    receivedByOwner: true,
  });
  await row.save(null, MASTER);
  orders.forEach((order) => order.set({ cashStatus: 'RECONCILED', settledAt: now }));
  await Parse.Object.saveAll(orders, MASTER);
  await audit(actor, 'cash.received_by_owner', row, null, { amount: row.get('amount'), note });
  await notifyUser(rider, {
    kind: 'cash.handover_confirmed',
    tone: 'update',
    title: `${money(config, row.get('amount'))} received by the owner`,
    body: note,
    link: '/rider/cash',
  });
  return { id: row.id, amount: row.get('amount') };
});

function handoverJSON(row) {
  return {
    id: row.id,
    code: row.get('handoverCode'),
    status: row.get('status'),
    amount: Number(row.get('amount') || 0),
    orderCount: row.get('orderCount') || 0,
    countedAmount: row.get('countedAmount') ?? null,
    returnedAmount: Number(row.get('returnedAmount') || 0),
    returnedCount: (row.get('returnedOrders') || []).length,
    disputeReason: row.get('disputeReason') || '',
    resolution: row.get('resolution') || '',
    resolutionNote: row.get('resolutionNote') || '',
    shortage: Number(row.get('shortage') || 0),
    shortageStatus: row.get('shortageStatus') || '',
    handedOverAt: row.get('handedOverAt'),
    confirmedAt: row.get('confirmedAt') || null,
    receivedByOwner: row.get('receivedByOwner') === true,
  };
}

// Rider: their recent handovers, so they can see what is still waiting.
Parse.Cloud.define('getMyHandovers', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const query = new Parse.Query('CashHandover');
  query.equalTo('rider', rider);
  query.descending('handedOverAt');
  query.limit(20);
  return (await query.find(MASTER)).map(handoverJSON);
});

// Staff: handovers still waiting for a count, oldest first, with how long
// each has waited. Also used by the notification check below.
async function pendingHandovers() {
  const query = new Parse.Query('CashHandover');
  query.equalTo('status', 'pending');
  query.include('rider');
  query.ascending('handedOverAt');
  query.limit(200);
  return query.find(MASTER);
}

// Tells cashiers and the owner once about each handover that has waited
// longer than STALE_HOURS. Called from getNotifications (staff only), at most
// every few minutes per server.
const STALE_CHECK_MS = Number(process.env.RELAY_STALE_CHECK_MS ?? 180000);
let lastStaleCheck = 0;
async function staleHandoverAlerts(config) {
  if (Date.now() - lastStaleCheck < STALE_CHECK_MS) return 0;
  lastStaleCheck = Date.now();
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000);
  let sent = 0;
  for (const row of await pendingHandovers()) {
    if (row.get('handedOverAt') > cutoff) break;
    const hours = Math.floor((Date.now() - row.get('handedOverAt')) / 3600000);
    sent += await notifyStaff({
      kind: 'cash.handover_stale',
      tone: 'alert',
      key: `handover-stale:${row.id}`,
      title: `Handover ${row.get('handoverCode')} waiting ${hours} h`,
      body: `${personName(row.get('rider'))} · ${money(config, row.get('amount'))} has not been counted yet.`,
      link: '/cashier/handovers',
    });
  }
  return sent;
}

module.exports = { STALE_HOURS, staleHandoverAlerts, handoverJSON };
