const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  getRoleName,
  readAcl,
  audit,
  riderFloat,
} = require('./lib/core');
const { sumBy } = require('./lib/money');

// Opening float plus every handover this cashier confirmed since the shift began.
async function expectedTill(cashier, shift) {
  const query = new Parse.Query('CashHandover');
  query.equalTo('cashier', cashier);
  query.equalTo('status', 'confirmed');
  query.greaterThanOrEqualTo('confirmedAt', shift.get('startedAt'));
  query.limit(1000);
  const handovers = await query.find(MASTER);
  return Number(shift.get('openingFloat') || 0) + sumBy(handovers, (h) => h.get('amount'));
}

// What stops a rider from ending their shift: orders not yet delivered or
// cancelled, and cash not yet reconciled (held, or handed over but not yet
// confirmed by the cashier).
async function riderOutstanding(rider) {
  const openQuery = new Parse.Query('Order');
  openQuery.equalTo('createdBy', rider);
  openQuery.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  const cashQuery = new Parse.Query('Order');
  cashQuery.equalTo('createdBy', rider);
  cashQuery.equalTo('status', 'DELIVERED');
  cashQuery.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  cashQuery.limit(1000);
  const [openOrders, cashOrders] = await Promise.all([
    openQuery.count(MASTER),
    cashQuery.find(MASTER),
  ]);
  const sum = (status) =>
    sumBy(
      cashOrders.filter((o) => o.get('cashStatus') === status),
      (o) => o.get('amountCollected'),
    );
  return { openOrders, cashWithRider: sum('WITH_RIDER'), cashPending: sum('HANDOVER_PENDING') };
}

function outstandingProblem({ openOrders, cashWithRider, cashPending }) {
  if (openOrders)
    return `Finish or cancel your ${openOrders} open order${openOrders === 1 ? '' : 's'} before ending your shift`;
  if (cashWithRider) return 'Hand over the cash you are holding before ending your shift';
  if (cashPending)
    return 'Wait for the cashier to confirm your cash handover before ending your shift';
  return '';
}

function openShiftQuery(user) {
  const query = new Parse.Query('Shift');
  query.equalTo('operator', user);
  query.equalTo('status', 'open');
  query.descending('startedAt');
  return query;
}

Parse.Cloud.define('getMyShift', async (request) => {
  const user = requireUser(request);
  const shift = await openShiftQuery(user).first(MASTER);
  if (!shift) return { shift: null };
  const isCashier = shift.get('kind') === 'cashier';
  return {
    shift: {
      id: shift.id,
      kind: shift.get('kind'),
      startedAt: shift.get('startedAt'),
      openingFloat: shift.get('openingFloat'),
      expectedTill: isCashier ? await expectedTill(user, shift) : null,
      float: isCashier ? null : await riderFloat(user),
      outstanding: isCashier ? null : await riderOutstanding(user),
    },
  };
});

Parse.Cloud.define('startShift', async (request) => {
  const user = requireUser(request);
  const role = await getRoleName(user);
  const { kind } = request.params;
  const allowed =
    (kind === 'rider' && role === 'rider') ||
    (kind === 'cashier' && ['cashier', 'admin'].includes(role));
  if (!allowed) throw forbidden('Not allowed to start this shift');
  if (await openShiftQuery(user).first(MASTER)) throw invalid('Close the current shift first');
  const opening = Number(request.params.openingFloat || 0);
  if (!Number.isFinite(opening) || opening < 0) throw invalid('Invalid opening cash');
  const row = new Parse.Object('Shift');
  row.set({
    operator: user,
    kind,
    status: 'open',
    openingFloat: kind === 'cashier' ? opening : 0,
    startedAt: new Date(),
  });
  row.setACL(readAcl(user, ['admin']));
  await row.save(null, MASTER);
  await audit(user, 'shift.started', row, null, { kind, openingFloat: row.get('openingFloat') });
  return { id: row.id };
});

Parse.Cloud.define('endShift', async (request) => {
  const user = requireUser(request);
  const row = await new Parse.Query('Shift').get(request.params.shiftId, MASTER);
  if (row.get('operator')?.id !== user.id || row.get('status') !== 'open')
    throw forbidden('No open shift found');
  const isCashier = row.get('kind') === 'cashier';
  if (!isCashier) {
    const problem = outstandingProblem(await riderOutstanding(user));
    if (problem) throw invalid(problem);
  }
  const balance = 0;
  let expected = null;
  let counted = null;
  let variance = null;
  if (isCashier) {
    expected = await expectedTill(user, row);
    counted = Number(request.params.physicalCount);
    if (!Number.isFinite(counted) || counted < 0) throw invalid('Enter physical till count');
    variance = counted - expected;
  }
  row.set({
    status: 'closed',
    endedAt: new Date(),
    closingFloat: balance,
    acknowledgedCash: balance > 0,
    expectedTill: expected,
    physicalCount: counted,
    variance,
  });
  await row.save(null, MASTER);
  await audit(
    user,
    'shift.closed',
    row,
    { status: 'open' },
    { balance, expectedTill: expected, physicalCount: counted, variance },
  );
  return { balance, expectedTill: expected, variance };
});
