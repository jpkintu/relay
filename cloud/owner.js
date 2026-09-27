// The owner's dashboard (computed on the server, B7), the audit log viewer and
// the daily Z-report (end-of-day summary, saved each night and pushed to the
// owner's phone).

const {
  MASTER,
  invalid,
  adminOnly,
  readAcl,
  audit,
  loadConfig,
  personName,
} = require('./lib/core');
const {
  resolveRange,
  bucketKeys,
  bucketOf,
  isoDay,
  localClock,
  addDays,
  isDay,
} = require('./lib/dates');
const R = require('./lib/reports');
const { sumBy } = require('./lib/money');
const { factOf, findAll, ordersIn, orderLines } = require('./reports');
const { payOwed } = require('./payouts');
const { money, notifyAdmins } = require('./notifications');

const OPEN = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'];

const dayRange = (day, timezone) => {
  const range = resolveRange({ from: day, to: day }, timezone);
  if (range.error) throw invalid(range.error);
  return range;
};

// Cash still with riders (delivered, not reconciled), across all days.
async function cashWithRiders() {
  const query = new Parse.Query('Order');
  query.equalTo('status', 'DELIVERED');
  query.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  query.select('amountCollected', 'cashStatus', 'createdBy');
  const orders = await findAll(query);
  return {
    total: sumBy(orders, (o) => o.get('amountCollected')),
    withRiders: sumBy(
      orders.filter((o) => o.get('cashStatus') === 'WITH_RIDER'),
      (o) => o.get('amountCollected'),
    ),
    handedOver: sumBy(
      orders.filter((o) => o.get('cashStatus') === 'HANDOVER_PENDING'),
      (o) => o.get('amountCollected'),
    ),
    riders: new Set(orders.map((o) => o.get('createdBy')?.id)).size,
  };
}

// Cash counted into a till or taken by the owner during the range.
async function cashReceived(range) {
  const counted = new Parse.Query('CashHandover');
  counted.greaterThanOrEqualTo('tillAt', range.start);
  counted.lessThan('tillAt', range.end);
  const legacy = new Parse.Query('CashHandover');
  legacy.containedIn('status', ['confirmed', 'disputed']);
  legacy.doesNotExist('tillAt');
  legacy.greaterThanOrEqualTo('confirmedAt', range.start);
  legacy.lessThan('confirmedAt', range.end);
  const query = Parse.Query.or(counted, legacy);
  query.include(['rider', 'cashier']);
  const rows = await findAll(query);
  return rows.map((h) => ({
    riderId: h.get('rider')?.id || '',
    amount: Number(h.get('countedAmount') ?? h.get('amount') ?? 0),
    status: h.get('status'),
  }));
}

// Rider pay still owed (commission + unpaid delivery fees, less shortages).
async function riderPayOwed() {
  const orders = new Parse.Query('Order');
  orders.equalTo('status', 'DELIVERED');
  orders.notEqualTo('commissionPaid', true);
  const shortages = new Parse.Query('CashHandover');
  shortages.equalTo('shortageStatus', 'owed');
  const [unpaid, owed] = await Promise.all([findAll(orders), findAll(shortages)]);
  return sumBy(unpaid, payOwed) - sumBy(owed, (h) => h.get('shortage'));
}

// Owner: today's figures, the last 30 days and what needs attention.
Parse.Cloud.define('getDashboard', async (request) => {
  await adminOnly(request);
  const { values: config } = await loadConfig();
  const tz = config.timezone;
  const today = isoDay(new Date(), tz);
  const todayRange = dayRange(today, tz);
  const monthRange = resolveRange({ from: addDays(today, -29), to: today }, tz);
  const pendingMomo = new Parse.Query('Order');
  pendingMomo.equalTo('paymentStatus', 'PENDING_VERIFICATION');
  pendingMomo.notEqualTo('status', 'CANCELLED');
  const pendingHandovers = new Parse.Query('CashHandover').equalTo('status', 'pending');
  const disputed = new Parse.Query('CashHandover').equalTo('status', 'disputed');
  const issues = new Parse.Query('Order').equalTo('disputeFlag', true);
  const recent = new Parse.Query('Order');
  recent.include('createdBy');
  recent.descending('createdAt');
  recent.limit(15);
  const onShift = new Parse.Query('Shift').equalTo('status', 'open').include('operator');
  onShift.limit(200);
  const [todayFacts, deliveredToday, monthFacts, cash, received, owed, counts, recentRows, shifts] =
    await Promise.all([
      findAll(ordersIn(todayRange, 'createdAt')).then((rows) => rows.map(factOf)),
      findAll(ordersIn(todayRange, 'deliveredAt').equalTo('status', 'DELIVERED')).then((rows) =>
        rows.map(factOf),
      ),
      findAll(ordersIn(monthRange, 'createdAt')).then((rows) => rows.map(factOf)),
      cashWithRiders(),
      cashReceived(todayRange),
      riderPayOwed(),
      Promise.all([
        pendingMomo.count(MASTER),
        pendingHandovers.count(MASTER),
        disputed.count(MASTER),
        issues.count(MASTER),
      ]),
      recent.find(MASTER),
      onShift.find(MASTER),
    ]);
  const [momoPending, handoversPending, handoversDisputed, openIssues] = counts;
  const sales = R.summarize(deliveredToday);
  const riders = R.riderStats(deliveredToday).sort(
    (a, b) => b.delivered - a.delivered || b.revenue - a.revenue,
  );
  const hours = R.timeOfDay(todayFacts, (f) => localClock(f.createdAt, tz)).hours;
  const people = shifts.map((s) => s.get('operator')).filter(Boolean);
  return {
    day: today,
    today: {
      orders: todayFacts.length,
      open: todayFacts.filter((f) => OPEN.includes(f.status)).length,
      cancelled: todayFacts.filter((f) => f.status === 'CANCELLED').length,
      delivered: sales.delivered,
      sales: sales.revenue,
      riderPay: sales.commission,
      kept: sales.net,
      avgOrder: sales.avgOrder,
      avgDeliveryMinutes: sales.avgDeliveryMinutes ?? null,
      cashReceived: sumBy(received, (r) => r.amount),
    },
    topRider: riders[0]
      ? {
          rider: riders[0].rider,
          delivered: riders[0].delivered,
          sales: riders[0].revenue,
        }
      : null,
    cash: cash,
    riderPayOwed: owed,
    attention: { momoPending, handoversPending, handoversDisputed, openIssues },
    onShift: {
      riders: people.filter((u) => u.get('riderCode')).length,
      cashiers: people.filter((u) => !u.get('riderCode')).length,
      onBreak: people.filter((u) => u.get('riderCode') && u.get('available') === false).length,
    },
    hours: hours.map((h) => ({ hour: h.hour, orders: h.orders, sales: h.revenue })),
    days: R.series(monthFacts, bucketKeys(monthRange.from, monthRange.to, 'day'), (f) =>
      bucketOf(f.createdAt, tz, 'day'),
    ).map((row) => ({ day: row.key, orders: row.orders, sales: row.revenue })),
    recent: recentRows.map((o) => {
      const f = factOf(o);
      return {
        id: f.id,
        code: f.code,
        rider: f.rider,
        customer: f.customer,
        status: f.status,
        total: f.total,
        method: f.method,
        createdAt: f.createdAt,
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// Audit log

const AUDIT_GROUPS = [
  'order',
  'payment',
  'cash',
  'payout',
  'shift',
  'team',
  'rider',
  'menu',
  'stock',
  'configuration',
  'security',
  'owner',
  'report',
];
const PAGE = 100;

const parseJson = (json) => {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
};

// Readable names for the records the log points at.
async function entityLabels(rows) {
  const byType = new Map();
  for (const row of rows) {
    const type = row.get('entityType');
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(row.get('entityId'));
  }
  const fields = {
    Order: (o) => o.get('orderCode'),
    CashHandover: (o) => o.get('handoverCode'),
    TillPayout: (o) => o.get('payoutCode'),
    MenuItem: (o) => o.get('title'),
    MenuCategory: (o) => o.get('title'),
    Accompaniment: (o) => o.get('title'),
    _User: (o) => personName(o),
    ZReport: (o) => `Z-report ${o.get('day')}`,
  };
  const labels = new Map();
  await Promise.all(
    [...byType].map(async ([type, ids]) => {
      if (!fields[type]) return;
      const query = new Parse.Query(type === '_User' ? Parse.User : type);
      query.containedIn('objectId', [...ids].filter(Boolean));
      query.limit(ids.size);
      for (const object of await query.find(MASTER))
        labels.set(`${type}:${object.id}`, fields[type](object));
    }),
  );
  return labels;
}

// Owner: who did what, newest first, 100 at a time. Filters: dates, person,
// kind of action (order, payment, cash, …), and one record.
Parse.Cloud.define('adminGetAuditLog', async (request) => {
  await adminOnly(request);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = resolveRange(p, config.timezone, { defaultDays: 7, maxDays: 366 });
  if (range.error) throw invalid(range.error);
  const query = new Parse.Query('AuditLog');
  query.greaterThanOrEqualTo('createdAt', range.start);
  query.lessThan('createdAt', range.end);
  if (p.before) {
    const before = new Date(p.before);
    if (Number.isNaN(before.getTime())) throw invalid('Bad page');
    query.lessThan('createdAt', before < range.end ? before : range.end);
  }
  if (p.actorId) {
    if (!/^[A-Za-z0-9]{1,32}$/.test(String(p.actorId))) throw invalid('Unknown person');
    query.equalTo('actor', Parse.User.createWithoutData(String(p.actorId)));
  }
  if (p.group) {
    if (!AUDIT_GROUPS.includes(p.group)) throw invalid('Unknown kind of action');
    query.startsWith('action', `${p.group}.`);
  }
  if (p.entityId) {
    if (!/^[A-Za-z0-9]{1,32}$/.test(String(p.entityId))) throw invalid('Unknown record');
    query.equalTo('entityId', String(p.entityId));
  }
  query.include('actor');
  query.descending('createdAt');
  query.limit(PAGE + 1);
  const found = await query.find(MASTER);
  const rows = found.slice(0, PAGE);
  const labels = await entityLabels(rows);
  return {
    range: { from: range.from, to: range.to },
    groups: AUDIT_GROUPS,
    rows: rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      action: row.get('action'),
      actorId: row.get('actor')?.id || '',
      actor: personName(row.get('actor')) || 'System',
      entityType: row.get('entityType'),
      entityId: row.get('entityId'),
      entity: labels.get(`${row.get('entityType')}:${row.get('entityId')}`) || '',
      before: parseJson(row.get('beforeJson')),
      after: parseJson(row.get('afterJson')),
    })),
    next: found.length > PAGE ? rows[rows.length - 1].createdAt : null,
  };
});

// ---------------------------------------------------------------------------
// Daily Z-report

async function buildZReport(day, config) {
  const tz = config.timezone;
  const range = dayRange(day, tz);
  const placedQuery = ordersIn(range, 'createdAt');
  const deliveredQuery = ordersIn(range, 'deliveredAt').equalTo('status', 'DELIVERED');
  const cancelledQuery = ordersIn(range, 'cancelledAt').equalTo('status', 'CANCELLED');
  const payoutQuery = new Parse.Query('TillPayout');
  payoutQuery.greaterThanOrEqualTo('paidAt', range.start);
  payoutQuery.lessThan('paidAt', range.end);
  const shiftQuery = new Parse.Query('Shift');
  shiftQuery.equalTo('kind', 'cashier');
  shiftQuery.equalTo('status', 'closed');
  shiftQuery.greaterThanOrEqualTo('endedAt', range.start);
  shiftQuery.lessThan('endedAt', range.end);
  shiftQuery.include('operator');
  const disputeQuery = new Parse.Query('CashHandover');
  disputeQuery.equalTo('status', 'disputed');
  disputeQuery.greaterThanOrEqualTo('handedOverAt', range.start);
  disputeQuery.lessThan('handedOverAt', range.end);
  const [placed, delivered, cancelled, payouts, shifts, received, disputes, stillWithRiders] =
    await Promise.all([
      placedQuery.count(MASTER),
      findAll(deliveredQuery).then((rows) => rows.map(factOf)),
      cancelledQuery.count(MASTER),
      findAll(payoutQuery),
      findAll(shiftQuery),
      cashReceived(range),
      disputeQuery.count(MASTER),
      cashWithRiders(),
    ]);
  const sales = R.summarize(delivered);
  const lines = await orderLines(delivered.map((f) => f.id));
  const cash = delivered.filter((f) => f.method === 'cash');
  const momo = delivered.filter((f) => f.method === 'mobile_money');
  const momoBy = (status) => momo.filter((f) => f.paymentStatus === status);
  const riderPayouts = payouts.filter((row) => row.get('kind') === 'rider');
  const receivedBy = new Map();
  for (const row of received)
    receivedBy.set(row.riderId, (receivedBy.get(row.riderId) || 0) + row.amount);
  return {
    day,
    orders: {
      placed,
      delivered: sales.delivered,
      cancelled,
      avgOrder: sales.avgOrder,
      avgDeliveryMinutes: sales.avgDeliveryMinutes ?? null,
    },
    sales: {
      total: sales.revenue,
      food: sales.foodSales,
      deliveryFees: sales.deliveryFees,
      riderCommission: sales.riderCommission,
      riderPay: sales.commission,
      kept: sales.net,
    },
    payments: {
      cash: sumBy(cash, (f) => f.amountCollected),
      cashOrders: cash.length,
      mobileMoneyVerified: sumBy(momoBy('VERIFIED'), (f) => f.total),
      mobileMoneyPending: sumBy(momoBy('PENDING_VERIFICATION'), (f) => f.total),
      mobileMoneyRejected: momoBy('REJECTED').length,
    },
    till: {
      cashReceived: sumBy(received, (r) => r.amount),
      riderPay: sumBy(riderPayouts, (row) => row.get('amount')),
      otherPayouts: sumBy(
        payouts.filter((row) => row.get('kind') !== 'rider'),
        (row) => row.get('amount'),
      ),
      disputes,
      cashWithRidersNow: stillWithRiders.total,
    },
    shifts: shifts.map((s) => ({
      cashier: personName(s.get('operator')),
      opening: Number(s.get('openingFloat') || 0),
      cashIn: s.get('cashIn') ?? null,
      paidOut: s.get('paidOut') ?? null,
      expected: s.get('expectedTill') ?? null,
      counted: s.get('physicalCount') ?? null,
      variance: s.get('variance') ?? 0,
      note: s.get('varianceNote') || '',
    })),
    riders: R.riderStats(delivered)
      .sort((a, b) => b.revenue - a.revenue)
      .map((row) => ({
        rider: row.rider,
        delivered: row.delivered,
        sales: row.revenue,
        cash: sumBy(
          cash.filter((f) => f.riderId === row.riderId),
          (f) => f.amountCollected,
        ),
        handedOver: receivedBy.get(row.riderId) || 0,
        riderPay: row.commission,
      })),
    items: R.itemSales(lines)
      .slice(0, 10)
      .map(({ name, qty, revenue }) => ({ name, qty, revenue })),
  };
}

async function storedZReport(day) {
  return new Parse.Query('ZReport').equalTo('day', day).first(MASTER);
}

async function saveZReport(day, data, actor) {
  const row = (await storedZReport(day)) || new Parse.Object('ZReport');
  row.set({ day, data, generatedAt: new Date(), auto: !actor });
  row.setACL(readAcl(null, ['admin']));
  await row.save(null, MASTER);
  await audit(actor || null, 'report.z_saved', row, null, {
    day,
    sales: data.sales.total,
    kept: data.sales.kept,
  });
  return row;
}

const zSummary = (config, data) =>
  [
    `${data.orders.delivered} delivered`,
    `sales ${money(config, data.sales.total)}`,
    `kept ${money(config, data.sales.kept)}`,
    data.till.cashWithRidersNow
      ? `${money(config, data.till.cashWithRidersNow)} still with riders`
      : '',
    data.shifts.some((s) => s.variance)
      ? `till off by ${money(
          config,
          data.shifts.reduce((n, s) => n + Math.abs(s.variance || 0), 0),
        )}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

// Builds and saves today's Z-report once the restaurant's Z-report hour has
// passed, and tells the owner. Runs from the Cloud Job (schedule it hourly) and
// whenever an owner opens the app, so it happens even without the job
// (RELAY_Z_CHECK_MS=-1 turns the automatic check off, as in the e2e tests).
const Z_CHECK_MS = Number(process.env.RELAY_Z_CHECK_MS ?? 600000);
let lastZCheck = 0;
async function zReportDue(config, { force = false } = {}) {
  if (!force && (Z_CHECK_MS < 0 || Date.now() - lastZCheck < Z_CHECK_MS)) return null;
  lastZCheck = Date.now();
  const now = new Date();
  if (localClock(now, config.timezone).hour < Number(config.zReportHour ?? 23)) return null;
  const day = isoDay(now, config.timezone);
  if (await storedZReport(day)) return null;
  const data = await buildZReport(day, config);
  const row = await saveZReport(day, data, null);
  await notifyAdmins({
    kind: 'report.z',
    tone: 'update',
    key: `z-report:${day}`,
    title: `Z-report for ${day}`,
    body: zSummary(config, data),
    link: `/admin/reports/z/${day}`,
  });
  return row;
}

Parse.Cloud.job('dailyZReport', async () => {
  const { values: config } = await loadConfig();
  const row = await zReportDue(config, { force: true });
  return row ? `Z-report saved for ${row.get('day')}` : 'Not due yet (or already saved)';
});

// Owner: one day's Z-report. Past days come from the saved copy (saved on
// first view if the nightly one is missing); today is always built live.
Parse.Cloud.define('adminGetZReport', async (request) => {
  const actor = await adminOnly(request);
  const { values: config } = await loadConfig();
  const today = isoDay(new Date(), config.timezone);
  const day = request.params.day || today;
  if (!isDay(day) || day > today) throw invalid('Choose a day up to today');
  if (day === today)
    return { day, live: true, savedAt: null, report: await buildZReport(day, config) };
  let row = await storedZReport(day);
  if (!row) row = await saveZReport(day, await buildZReport(day, config), actor);
  return { day, live: false, savedAt: row.get('generatedAt'), report: row.get('data') };
});

// Owner: saved Z-reports, newest first.
Parse.Cloud.define('adminListZReports', async (request) => {
  await adminOnly(request);
  const query = new Parse.Query('ZReport');
  query.descending('day');
  query.limit(62);
  return (await query.find(MASTER)).map((row) => ({
    day: row.get('day'),
    savedAt: row.get('generatedAt'),
    delivered: row.get('data')?.orders?.delivered ?? 0,
    sales: row.get('data')?.sales?.total ?? 0,
    kept: row.get('data')?.sales?.kept ?? 0,
  }));
});

module.exports = { zReportDue, buildZReport };
