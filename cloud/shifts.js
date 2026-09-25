const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  getRoleName,
  readAcl,
  audit,
} = require('./lib/core');
const { sumBy } = require('./lib/money');
const { riderFloat } = require('./orders');

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
  const balance = isCashier ? 0 : await riderFloat(user);
  if (balance > 0 && request.params.acknowledgeCash !== true)
    throw invalid('Cash remains with you. Acknowledge it before ending your shift');
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
