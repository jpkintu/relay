// Filtered ledgers and reports: payments (cash + mobile money), orders,
// commissions, rider earnings and the owner's operations report.
//
// Every function takes an inclusive { from, to } range of 'YYYY-MM-DD' days
// in the restaurant timezone (see lib/dates.js). Money totals are computed
// here from orders; nothing is stored.

const { MASTER, invalid, requireRole, loadConfig } = require('./lib/core');
const { merchantAccounts } = require('./lib/mobileMoney');
const { resolveRange, previousRange, bucketOf, bucketKeys, localClock } = require('./lib/dates');
const R = require('./lib/reports');
const { orderRiderPay } = require('./lib/money');

const MAX_ROWS = 2000;
const PERIODS = ['day', 'week', 'month'];

const nameOf = (user) =>
  user
    ? [user.get('riderCode') || user.get('cashierCode'), user.get('name') || user.get('username')]
        .filter(Boolean)
        .join(' · ')
    : '';

async function findAll(query) {
  const rows = [];
  await query.eachBatch((batch) => void rows.push(...batch), { ...MASTER, batchSize: 1000 });
  return rows;
}

function rangeOf(params, config, options) {
  const range = resolveRange(params, config.timezone, options);
  if (range.error) throw invalid(range.error);
  return range;
}

const riderPointer = (id) => {
  if (!id) return null;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(id)) throw invalid('Unknown rider');
  return Parse.User.createWithoutData(id);
};

const METHODS = ['all', 'cash', 'mobile_money'];
function methodOf(params) {
  const method = params.method || 'all';
  if (!METHODS.includes(method)) throw invalid('Payment type must be cash or mobile_money');
  return method;
}

function periodOf(params, range) {
  if (params.period) {
    if (!PERIODS.includes(params.period)) throw invalid('Group by day, week or month');
    return params.period;
  }
  return range.days <= 31 ? 'day' : range.days <= 120 ? 'week' : 'month';
}

// Orders whose `field` falls inside the range (optionally one rider's).
function ordersIn(range, field, riderId) {
  const query = new Parse.Query('Order');
  query.greaterThanOrEqualTo(field, range.start);
  query.lessThan(field, range.end);
  const rider = riderPointer(riderId);
  if (rider) query.equalTo('createdBy', rider);
  query.include('createdBy');
  return query;
}

function factOf(order) {
  const rider = order.get('createdBy');
  const phone = order.get('customerPhone');
  const name = String(order.get('customerName') || '').toLowerCase();
  return {
    id: order.id,
    code: order.get('orderCode'),
    status: order.get('status'),
    restaurantStatus: order.get('restaurantStatus'),
    channel: order.get('channel'),
    customer: order.get('customerName') || '',
    customerKey: order.get('customer')?.id || (phone ? `tel:${phone}` : name && `name:${name}`),
    riderId: rider?.id || '',
    rider: nameOf(rider),
    total: Number(order.get('total') || 0),
    subtotal: Number(order.get('subtotal') || 0),
    deliveryFee: Number(order.get('deliveryFee') || 0),
    // Rider pay: commission + delivery fee, taken off revenue like commission.
    commission: order.get('status') === 'DELIVERED' ? orderRiderPay(order) : 0,
    method: order.get('paymentMethod'),
    provider: order.get('paymentProvider') || '',
    reference: order.get('paymentReference') || '',
    paymentStatus: order.get('paymentStatus') || '',
    amountCollected: Number(order.get('amountCollected') || 0),
    cashStatus: order.get('cashStatus') || '',
    createdAt: order.createdAt,
    deliveredAt: order.get('deliveredAt') || null,
  };
}

const byNewest = (field) => (a, b) => (b[field] || 0) - (a[field] || 0);
const rangeInfo = (range) => ({ from: range.from, to: range.to, days: range.days });

// Riders for the filter drop-downs (everyone who has ever had a rider code).
Parse.Cloud.define('getReportOptions', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
  const query = new Parse.Query(Parse.User);
  query.exists('riderCode');
  query.ascending('riderCode');
  query.limit(1000);
  const riders = await query.find(MASTER);
  return {
    riders: riders.map((user) => ({
      id: user.id,
      label: nameOf(user),
      active: user.get('active') !== false,
    })),
  };
});

// Every cash collection and mobile money payment in the range, for
// reconciliation: cash by delivery date, mobile money by order date.
Parse.Cloud.define('getPaymentsLedger', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const method = methodOf(p);
  const wantCash = method !== 'mobile_money';
  const wantMomo = method !== 'cash';

  const cashQuery = ordersIn(range, 'deliveredAt', p.riderId);
  cashQuery.equalTo('paymentMethod', 'cash');
  cashQuery.equalTo('status', 'DELIVERED');
  const momoQuery = ordersIn(range, 'createdAt', p.riderId);
  momoQuery.equalTo('paymentMethod', 'mobile_money');
  momoQuery.include('paymentCheckedBy');
  const handoverQuery = new Parse.Query('CashHandover');
  handoverQuery.greaterThanOrEqualTo('createdAt', new Date(range.start.getTime() - 7 * 864e5));
  handoverQuery.lessThan('createdAt', new Date(range.end.getTime() + 7 * 864e5));
  if (p.riderId) handoverQuery.equalTo('rider', riderPointer(p.riderId));
  handoverQuery.include(['rider', 'cashier']);

  const [cashOrders, momoOrders, handovers] = await Promise.all([
    wantCash ? findAll(cashQuery) : [],
    wantMomo ? findAll(momoQuery) : [],
    wantCash ? findAll(handoverQuery) : [],
  ]);

  const handoverOf = new Map();
  for (const handover of handovers)
    for (const order of handover.get('orders') || [])
      if (handover.get('status') !== 'disputed' || !handoverOf.has(order.id))
        handoverOf.set(order.id, handover.get('handoverCode'));

  const cashRows = cashOrders.map((order) => {
    const f = factOf(order);
    return {
      id: f.id,
      kind: 'cash',
      at: f.deliveredAt,
      code: f.code,
      riderId: f.riderId,
      rider: f.rider,
      customer: f.customer,
      amount: f.amountCollected,
      orderTotal: f.total,
      status: f.cashStatus,
      provider: '',
      reference: handoverOf.get(order.id) || '',
      note: order.get('shortfallNote') || '',
    };
  });
  const momoRows = momoOrders.map((order) => {
    const f = factOf(order);
    return {
      id: f.id,
      kind: 'mobile_money',
      at: f.createdAt,
      code: f.code,
      riderId: f.riderId,
      rider: f.rider,
      customer: f.customer,
      amount: f.total,
      orderTotal: f.total,
      orderStatus: f.status,
      status: f.paymentStatus,
      provider: f.provider,
      reference: f.reference,
      note:
        order.get('paymentRejectReason') ||
        (f.status === 'CANCELLED' ? 'Order cancelled' : nameOf(order.get('paymentCheckedBy'))),
    };
  });

  const sum = (rows, test) => rows.filter(test).reduce((n, row) => n + row.amount, 0);
  const count = (rows, test) => rows.filter(test).length;
  // A pending payment on a cancelled order is no longer waiting for money.
  const liveMomo = momoRows.filter((r) => r.orderStatus !== 'CANCELLED' || r.status === 'VERIFIED');
  const handoverRows = handovers
    .filter((h) => h.createdAt >= range.start && h.createdAt < range.end)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((h) => ({
      id: h.id,
      code: h.get('handoverCode'),
      riderId: h.get('rider')?.id || '',
      rider: nameOf(h.get('rider')),
      cashier: nameOf(h.get('cashier')),
      amount: Number(h.get('amount') || 0),
      countedAmount: h.get('countedAmount') ?? null,
      orderCount: h.get('orderCount') || 0,
      status: h.get('status'),
      reason: h.get('disputeReason') || '',
      createdAt: h.createdAt,
      confirmedAt: h.get('confirmedAt') || null,
      returnedAmount: Number(h.get('returnedAmount') || 0),
      shortage: Number(h.get('shortage') || 0),
      shortageStatus: h.get('shortageStatus') || '',
      resolutionNote: h.get('resolutionNote') || '',
      receivedByOwner: h.get('receivedByOwner') === true,
    }));
  const transactions = [...cashRows, ...momoRows].sort(byNewest('at'));

  return {
    range: rangeInfo(range),
    method,
    summary: {
      total: sum(cashRows, () => true) + sum(liveMomo, (r) => r.status === 'VERIFIED'),
      cash: {
        count: cashRows.length,
        collected: sum(cashRows, () => true),
        withRiders: sum(cashRows, (r) => r.status === 'WITH_RIDER'),
        handoverPending: sum(cashRows, (r) => r.status === 'HANDOVER_PENDING'),
        reconciled: sum(cashRows, (r) => r.status === 'RECONCILED'),
      },
      mobileMoney: {
        count: momoRows.length,
        verified: sum(momoRows, (r) => r.status === 'VERIFIED'),
        verifiedCount: count(momoRows, (r) => r.status === 'VERIFIED'),
        pending: sum(liveMomo, (r) => r.status === 'PENDING_VERIFICATION'),
        pendingCount: count(liveMomo, (r) => r.status === 'PENDING_VERIFICATION'),
        rejected: sum(momoRows, (r) => r.status === 'REJECTED'),
        rejectedCount: count(momoRows, (r) => r.status === 'REJECTED'),
        byProvider: merchantAccounts(config).map((account) => {
          const rows = momoRows.filter(
            (r) => r.provider === account.provider && r.status === 'VERIFIED',
          );
          return { ...account, count: rows.length, amount: sum(rows, () => true) };
        }),
      },
      handovers: {
        count: handoverRows.length,
        confirmed: handoverRows
          .filter((h) => h.status === 'confirmed')
          .reduce((n, h) => n + h.amount, 0),
        pending: handoverRows
          .filter((h) => h.status === 'pending')
          .reduce((n, h) => n + h.amount, 0),
        disputed: handoverRows.filter((h) => h.status === 'disputed').length,
      },
    },
    transactions: transactions.slice(0, MAX_ROWS),
    truncated: transactions.length > MAX_ROWS,
    handovers: handoverRows,
  };
});

const ORDER_STATUSES = ['open', 'DELIVERED', 'CANCELLED', 'PICKED_UP'];

// Admin orders ledger with date, rider, status and payment filters.
Parse.Cloud.define('adminSearchOrders', async (request) => {
  await requireRole(request, ['admin']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const method = methodOf(p);
  const query = ordersIn(range, 'createdAt', p.riderId);
  if (method !== 'all') query.equalTo('paymentMethod', method);
  if (p.status) {
    if (!ORDER_STATUSES.includes(p.status)) throw invalid('Unknown status filter');
    if (p.status === 'open')
      query.containedIn('status', ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP']);
    else query.equalTo('status', p.status);
  }
  const facts = (await findAll(query)).map(factOf).sort(byNewest('createdAt'));
  return {
    range: rangeInfo(range),
    summary: R.summarize(facts),
    rows: facts.slice(0, MAX_ROWS).map(({ customerKey: _key, ...row }) => row),
    truncated: facts.length > MAX_ROWS,
  };
});

// Commission earned on deliveries in the range, with a total per rider.
Parse.Cloud.define('getCommissionLedger', async (request) => {
  await requireRole(request, ['admin']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const query = ordersIn(range, 'deliveredAt', p.riderId);
  query.equalTo('status', 'DELIVERED');
  const facts = (await findAll(query)).map(factOf).sort(byNewest('deliveredAt'));
  const riders = R.riderStats(facts).sort((a, b) => b.commission - a.commission);
  return {
    range: rangeInfo(range),
    total: facts.reduce((n, f) => n + f.commission, 0),
    deliveries: facts.length,
    riders: riders.map(({ riderId, rider, delivered, revenue, commission }) => ({
      riderId,
      rider,
      deliveries: delivered,
      sales: revenue,
      commission,
    })),
    rows: facts.slice(0, MAX_ROWS).map((f) => ({
      id: f.id,
      code: f.code,
      riderId: f.riderId,
      rider: f.rider,
      customer: f.customer,
      total: f.total,
      subtotal: f.subtotal,
      commission: f.commission,
      method: f.method,
      deliveredAt: f.deliveredAt,
    })),
    truncated: facts.length > MAX_ROWS,
  };
});

async function earningsFacts(range, riderId) {
  const query = ordersIn(range, 'deliveredAt', riderId);
  query.equalTo('status', 'DELIVERED');
  return (await findAll(query)).map(factOf);
}

// A rider's own earnings (admins may pass riderId), grouped by week or month
// of delivery, with the same-length period before for comparison.
Parse.Cloud.define('getRiderEarnings', async (request) => {
  const { user, role } = await requireRole(request, ['rider', 'admin']);
  const p = request.params;
  const riderId = role === 'admin' ? p.riderId || user.id : user.id;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 56 });
  const period = periodOf(p, range);
  const before = previousRange(range, config.timezone);
  const [facts, previousFacts] = await Promise.all([
    earningsFacts(range, riderId),
    earningsFacts(before, riderId),
  ]);
  const totals = (rows) => ({
    deliveries: rows.length,
    earnings: rows.reduce((n, f) => n + f.commission, 0),
    sales: rows.reduce((n, f) => n + f.total, 0),
    cash: rows.filter((f) => f.method === 'cash').reduce((n, f) => n + f.amountCollected, 0),
  });
  const current = totals(facts);
  const previous = totals(previousFacts);
  const keyOf = (f) => bucketOf(f.deliveredAt, config.timezone, period);
  return {
    range: rangeInfo(range),
    previousRange: rangeInfo(before),
    period,
    summary: {
      ...current,
      avgPerDelivery: current.deliveries ? Math.round(current.earnings / current.deliveries) : 0,
      earningsChange: R.growth(current.earnings, previous.earnings),
      deliveriesChange: R.growth(current.deliveries, previous.deliveries),
    },
    previous,
    series: R.series(facts, bucketKeys(range.from, range.to, period), keyOf).map((row) => ({
      key: row.key,
      deliveries: row.delivered,
      earnings: row.commission,
      sales: row.revenue,
      change: row.commissionChange,
    })),
    deliveries: facts
      .sort(byNewest('deliveredAt'))
      .slice(0, 300)
      .map((f) => ({
        id: f.id,
        code: f.code,
        customer: f.customer,
        total: f.total,
        commission: f.commission,
        method: f.method,
        deliveredAt: f.deliveredAt,
      })),
  };
});

async function orderLines(orderIds) {
  const lines = [];
  for (let i = 0; i < orderIds.length; i += 500) {
    const query = new Parse.Query('OrderItem');
    query.containedIn(
      'order',
      orderIds.slice(i, i + 500).map((id) => Parse.Object.extend('Order').createWithoutData(id)),
    );
    for (const item of await findAll(query))
      lines.push({
        name: item.get('itemNameSnapshot') || 'Item',
        qty: Number(item.get('quantity') || 0),
        total: Number(item.get('lineTotal') || 0),
        accompaniments: item.get('accompanimentNames') || [],
      });
  }
  return lines;
}

// The owner's report: revenue over time, growth against the previous period
// and month on month, menu item sales, riders, payment mix and busy hours.
Parse.Cloud.define('getOperationsReport', async (request) => {
  await requireRole(request, ['admin']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const tz = config.timezone;
  const range = rangeOf(p, config, { defaultDays: 30 });
  const period = periodOf(p, range);
  const before = previousRange(range, tz);
  const [facts, previousFacts] = await Promise.all([
    findAll(ordersIn(range, 'createdAt', p.riderId)).then((rows) => rows.map(factOf)),
    findAll(ordersIn(before, 'createdAt', p.riderId)).then((rows) => rows.map(factOf)),
  ]);
  const delivered = facts.filter((f) => f.status === 'DELIVERED');
  const lines = await orderLines(delivered.map((f) => f.id));
  const summary = R.summarize(facts);
  const previous = R.summarize(previousFacts);
  const change = {};
  for (const key of [
    'revenue',
    'orders',
    'delivered',
    'avgOrder',
    'commission',
    'net',
    'customers',
  ])
    change[key] = R.growth(summary[key], previous[key]);
  const keyOf = (bucket) => (f) => bucketOf(f.createdAt, tz, bucket);
  return {
    range: rangeInfo(range),
    previousRange: rangeInfo(before),
    period,
    summary,
    previous,
    change,
    series: R.series(facts, bucketKeys(range.from, range.to, period), keyOf(period)),
    monthly: R.series(facts, bucketKeys(range.from, range.to, 'month'), keyOf('month')),
    items: R.itemSales(lines),
    accompaniments: R.accompanimentCounts(lines).slice(0, 30),
    riders: R.riderStats(facts),
    payments: R.paymentMix(facts),
    channels: R.channelMix(facts),
    ...R.timeOfDay(facts, (f) => localClock(f.createdAt, tz)),
  };
});
