// Money paid out of the till: rider pay (commission + delivery fees, less any
// cash shortage charged to them) and other expenses. Every payout lowers the
// paying cashier's expected till.

const {
  MASTER,
  invalid,
  requireRole,
  readAcl,
  audit,
  loadConfig,
  nextDailyCode,
  requireCashierShift,
  claimOnce,
  verifyPin,
  personName,
  getRoleName,
} = require('./lib/core');
const { sumBy } = require('./lib/money');
const { money, notifyUser, notifyAdmins } = require('./notifications');
const { resolveRange } = require('./lib/dates');

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

// What the restaurant owes a rider right now.
async function riderPayState(rider) {
  const orderQuery = new Parse.Query('Order');
  orderQuery.equalTo('createdBy', rider);
  orderQuery.equalTo('status', 'DELIVERED');
  orderQuery.notEqualTo('commissionPaid', true);
  orderQuery.greaterThan('commissionAmount', 0);
  orderQuery.ascending('deliveredAt');
  orderQuery.limit(1000);
  const shortageQuery = new Parse.Query('CashHandover');
  shortageQuery.equalTo('rider', rider);
  shortageQuery.equalTo('shortageStatus', 'owed');
  shortageQuery.limit(200);
  const [orders, shortages] = await Promise.all([
    orderQuery.find(MASTER),
    shortageQuery.find(MASTER),
  ]);
  const earned = sumBy(orders, (order) => order.get('commissionAmount'));
  const deductions = sumBy(shortages, (row) => row.get('shortage'));
  return { orders, shortages, earned, deductions, owed: earned - deductions };
}

// Cashier's open shift, required for till payouts (admins pay without a till).
async function openCashierShift(user) {
  return new Parse.Query('Shift')
    .equalTo('operator', user)
    .equalTo('kind', 'cashier')
    .equalTo('status', 'open')
    .first(MASTER);
}

function payoutJSON(row) {
  return {
    id: row.id,
    code: row.get('payoutCode'),
    kind: row.get('kind'),
    amount: Number(row.get('amount') || 0),
    earned: Number(row.get('earned') || 0),
    deductions: Number(row.get('deductions') || 0),
    orderCount: (row.get('orders') || []).length,
    note: row.get('note') || '',
    rider: row.get('rider') ? personName(row.get('rider')) : '',
    paidBy: row.get('paidBy') ? personName(row.get('paidBy')) : '',
    fromTill: !!row.get('shift'),
    paidAt: row.get('paidAt'),
  };
}

// Staff: every rider the restaurant owes, with the amount.
Parse.Cloud.define('getRiderPay', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
  const role = await new Parse.Query(Parse.Role).equalTo('name', 'rider').first(MASTER);
  const riders = role ? await role.getUsers().query().limit(500).find(MASTER) : [];
  const rows = await Promise.all(
    riders.map(async (rider) => {
      const state = await riderPayState(rider);
      return {
        riderId: rider.id,
        rider: personName(rider),
        active: rider.get('active') !== false,
        deliveries: state.orders.length,
        earned: state.earned,
        deductions: state.deductions,
        owed: state.owed,
      };
    }),
  );
  return rows.filter((row) => row.earned > 0 || row.deductions > 0).sort((a, b) => b.owed - a.owed);
});

// Rider: what they are owed and their recent payouts.
Parse.Cloud.define('getMyPay', async (request) => {
  const { user: rider } = await requireRole(request, ['rider']);
  const state = await riderPayState(rider);
  const payouts = await new Parse.Query('TillPayout')
    .equalTo('rider', rider)
    .include('paidBy')
    .descending('paidAt')
    .limit(10)
    .find(MASTER);
  return {
    deliveries: state.orders.length,
    earned: state.earned,
    deductions: state.deductions,
    owed: state.owed,
    payouts: payouts.map(payoutJSON),
  };
});

async function newPayout(fields, config) {
  const row = new Parse.Object('TillPayout');
  row.set({
    payoutCode: await nextDailyCode('PO', 3, config.timezone, {
      className: 'TillPayout',
      field: 'payoutCode',
    }),
    paidAt: new Date(),
    ...fields,
  });
  row.setACL(readAcl(fields.rider || null));
  return row;
}

// Cashier (from the till, during a shift) or owner pays a rider everything
// they are owed. One payout per rider at a time.
Parse.Cloud.define('payRider', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  await verifyPin(actor, request.params.pin);
  const rider = await new Parse.Query(Parse.User).get(String(request.params.riderId), MASTER);
  if ((await getRoleName(rider)) !== 'rider') throw invalid('Choose a rider');
  const round = Number(rider.get('payRound') || 0);
  if (!(await claimOnce(`pay-rider:${rider.id}:${round}`)))
    throw invalid('This rider is already being paid. Refresh in a moment');
  try {
    const state = await riderPayState(rider);
    if (state.owed <= 0)
      throw invalid(
        state.deductions > state.earned
          ? 'Nothing to pay: the rider’s shortages are more than their earnings'
          : 'Nothing to pay',
      );
    const { values: config } = await loadConfig();
    const shift = role === 'cashier' ? await openCashierShift(actor) : null;
    const row = await newPayout(
      {
        kind: 'rider',
        rider,
        amount: state.owed,
        earned: state.earned,
        deductions: state.deductions,
        orders: state.orders,
        shortages: state.shortages,
        paidBy: actor,
        ...(shift && { shift }),
      },
      config,
    );
    await row.save(null, MASTER);
    state.orders.forEach((order) => order.set({ commissionPaid: true, commissionPayout: row }));
    state.shortages.forEach((h) => h.set({ shortageStatus: 'deducted', shortagePayout: row }));
    await Parse.Object.saveAll([...state.orders, ...state.shortages], MASTER);
    await audit(actor, 'payout.rider', row, null, {
      amount: state.owed,
      earned: state.earned,
      deductions: state.deductions,
      orders: state.orders.length,
    });
    await notifyUser(rider, {
      kind: 'payout.rider',
      tone: 'update',
      title: `You were paid ${money(config, state.owed)}`,
      body: `${state.orders.length} ${state.orders.length === 1 ? 'delivery' : 'deliveries'}${
        state.deductions ? ` less ${money(config, state.deductions)} shortage` : ''
      } · paid by ${personName(await actor.fetch(MASTER))}`,
      link: '/rider/earnings',
    });
    return { id: row.id, amount: state.owed };
  } finally {
    rider.increment('payRound');
    await rider.save(null, MASTER);
  }
});

// Cashier: any other cash taken out of the till (e.g. buying charcoal).
Parse.Cloud.define('recordTillPayout', async (request) => {
  const { user: cashier } = await requireRole(request, ['cashier']);
  const shift = await openCashierShift(cashier);
  if (!shift) throw invalid('Start your shift and count the cash in the till first');
  const amount = Math.round(Number(request.params.amount));
  const note = clean(request.params.note, 200);
  if (!Number.isFinite(amount) || amount <= 0) throw invalid('Enter the amount taken out');
  if (note.length < 5) throw invalid('Say what the money was for');
  await verifyPin(cashier, request.params.pin);
  const { values: config } = await loadConfig();
  const row = await newPayout({ kind: 'expense', amount, note, paidBy: cashier, shift }, config);
  await row.save(null, MASTER);
  await audit(cashier, 'payout.expense', row, null, { amount, note });
  await notifyAdmins({
    kind: 'payout.expense',
    tone: 'update',
    title: `${money(config, amount)} paid out of the till`,
    body: `${personName(await cashier.fetch(MASTER))}: ${note}`,
    link: '/admin/payments',
  });
  return { id: row.id, amount };
});

// Payouts in a date range (owner), or the caller's own shift (cashier).
Parse.Cloud.define('getTillPayouts', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  const query = new Parse.Query('TillPayout');
  if (role === 'admin') {
    const { values: config } = await loadConfig();
    const range = resolveRange(request.params, config.timezone, { defaultDays: 7 });
    if (range.error) throw invalid(range.error);
    query.greaterThanOrEqualTo('paidAt', range.start);
    query.lessThan('paidAt', range.end);
  } else {
    const shift = await openCashierShift(user);
    if (!shift) return { payouts: [], total: 0 };
    query.equalTo('shift', shift);
  }
  query.include(['rider', 'paidBy']);
  query.descending('paidAt');
  query.limit(500);
  const payouts = (await query.find(MASTER)).map(payoutJSON);
  return { payouts, total: payouts.reduce((n, p) => n + p.amount, 0) };
});

module.exports = { riderPayState };
