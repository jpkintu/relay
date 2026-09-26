const {
  MASTER,
  invalid,
  forbidden,
  requireUser,
  getRoleName,
  readAcl,
  audit,
  riderFloat,
  adminOnly,
  loadConfig,
  personName,
  verifyPin,
} = require('./lib/core');
const { money, notifyAdmins } = require('./notifications');
const { resolveRange } = require('./lib/dates');
const { sumBy } = require('./lib/money');

// The till during a shift: the opening count, plus rider cash this cashier
// took in (confirmed handovers, and the counted part of disputed ones), less
// money paid out (rider pay, expenses).
async function tillSummary(cashier, shift) {
  const start = shift.get('startedAt');
  const end = shift.get('endedAt') || new Date(Date.now() + 60000);
  const counted = new Parse.Query('CashHandover');
  counted.equalTo('cashier', cashier);
  counted.greaterThanOrEqualTo('tillAt', start);
  counted.lessThan('tillAt', end);
  // Handovers confirmed before tillAt existed.
  const legacy = new Parse.Query('CashHandover');
  legacy.equalTo('cashier', cashier);
  legacy.equalTo('status', 'confirmed');
  legacy.doesNotExist('tillAt');
  legacy.notEqualTo('receivedByOwner', true);
  legacy.greaterThanOrEqualTo('confirmedAt', start);
  legacy.lessThan('confirmedAt', end);
  const handoverQuery = Parse.Query.or(counted, legacy);
  handoverQuery.limit(1000);
  const payoutQuery = new Parse.Query('TillPayout');
  payoutQuery.equalTo('shift', shift);
  payoutQuery.limit(1000);
  const [handovers, payouts] = await Promise.all([
    handoverQuery.find(MASTER),
    payoutQuery.find(MASTER),
  ]);
  const openingFloat = Number(shift.get('openingFloat') || 0);
  const cashIn = sumBy(handovers, (h) => h.get('countedAmount') ?? h.get('amount'));
  const paidOut = sumBy(payouts, (row) => row.get('amount'));
  return { openingFloat, cashIn, paidOut, expected: openingFloat + cashIn - paidOut };
}

// Kitchen orders this cashier still holds.
function heldOrdersQuery(cashier) {
  const query = new Parse.Query('Order');
  query.equalTo('cashier', cashier);
  query.containedIn('status', ['PLACED', 'ACCEPTED', 'PREPARING', 'READY']);
  return query;
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
  const till = isCashier ? await tillSummary(user, shift) : null;
  return {
    shift: {
      id: shift.id,
      kind: shift.get('kind'),
      startedAt: shift.get('startedAt'),
      openingFloat: shift.get('openingFloat'),
      expectedTill: till ? till.expected : null,
      cashIn: till ? till.cashIn : null,
      paidOut: till ? till.paidOut : null,
      heldOrders: isCashier ? await heldOrdersQuery(user).count(MASTER) : null,
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
  // Cashiers count the till before starting: the count is required, even if 0.
  const raw = request.params.openingFloat;
  if (kind === 'cashier' && (raw === undefined || raw === null || raw === ''))
    throw invalid('Count the cash in the till and enter it to start your shift');
  const opening = Number(raw || 0);
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
  } else {
    const held = await heldOrdersQuery(user).count(MASTER);
    if (held)
      throw invalid(
        `You still hold ${held} kitchen order${held === 1 ? '' : 's'}. Finish or transfer ${
          held === 1 ? 'it' : 'them'
        } before ending your shift`,
      );
  }
  const balance = 0;
  let expected = null;
  let counted = null;
  let variance = null;
  let till = null;
  if (isCashier) {
    till = await tillSummary(user, row);
    expected = till.expected;
    const rawCount = request.params.physicalCount;
    counted = Number(rawCount);
    if (rawCount === undefined || rawCount === '' || !Number.isFinite(counted) || counted < 0)
      throw invalid('Enter physical till count');
    variance = counted - expected;
  }
  // A till that does not match must be explained before the shift can close.
  const varianceNote = String(request.params.varianceNote || '')
    .trim()
    .slice(0, 500);
  if (variance && varianceNote.length < 10)
    throw invalid('The till is off: explain the difference before ending your shift');
  await verifyPin(user, request.params.pin);
  row.set({
    ...(till && { cashIn: till.cashIn, paidOut: till.paidOut }),
    status: 'closed',
    endedAt: new Date(),
    closingFloat: balance,
    acknowledgedCash: balance > 0,
    expectedTill: expected,
    physicalCount: counted,
    variance,
    varianceNote: variance ? varianceNote : '',
  });
  await row.save(null, MASTER);
  await audit(
    user,
    'shift.closed',
    row,
    { status: 'open' },
    { balance, expectedTill: expected, physicalCount: counted, variance, varianceNote },
  );
  if (variance) {
    const { values: config } = await loadConfig();
    await notifyAdmins({
      kind: 'shift.variance',
      tone: 'alert',
      title: `Till ${variance > 0 ? 'over' : 'short'} by ${money(config, Math.abs(variance))}`,
      body: `${personName(await user.fetch(MASTER))}: counted ${money(config, counted)}, expected ${money(config, expected)}. "${varianceNote}"`,
      link: '/admin/payments',
      except: user,
    });
  }
  return { balance, expectedTill: expected, variance };
});

// Owner: cashier shifts in a date range with their till reconciliation.
Parse.Cloud.define('getShiftReport', async (request) => {
  await adminOnly(request);
  const { values: config } = await loadConfig();
  const range = resolveRange(request.params, config.timezone, { defaultDays: 7 });
  if (range.error) throw invalid(range.error);
  const query = new Parse.Query('Shift');
  query.equalTo('kind', 'cashier');
  query.greaterThanOrEqualTo('startedAt', range.start);
  query.lessThan('startedAt', range.end);
  query.include('operator');
  query.descending('startedAt');
  query.limit(500);
  const rows = await query.find(MASTER);
  const shifts = await Promise.all(
    rows.map(async (shift) => {
      const open = shift.get('status') === 'open';
      const till = open ? await tillSummary(shift.get('operator'), shift) : null;
      return {
        id: shift.id,
        cashier: personName(shift.get('operator')),
        status: shift.get('status'),
        startedAt: shift.get('startedAt'),
        endedAt: shift.get('endedAt') || null,
        openingFloat: Number(shift.get('openingFloat') || 0),
        cashIn: till ? till.cashIn : (shift.get('cashIn') ?? null),
        paidOut: till ? till.paidOut : (shift.get('paidOut') ?? null),
        expectedTill: till ? till.expected : (shift.get('expectedTill') ?? null),
        physicalCount: shift.get('physicalCount') ?? null,
        variance: shift.get('variance') ?? null,
        varianceNote: shift.get('varianceNote') || '',
      };
    }),
  );
  return {
    range: { from: range.from, to: range.to },
    shifts,
    totalVariance: shifts.reduce((n, s) => n + (Number(s.variance) || 0), 0),
  };
});
