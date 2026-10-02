// Filtered ledgers and reports: payments (cash + mobile money), orders,
// commissions, rider earnings and the owner's operations report.
//
// Every function takes an inclusive { from, to } range of 'YYYY-MM-DD' days
// in the restaurant timezone (see lib/dates.js). Money totals are computed
// here from orders; nothing is stored.

const { invalid, requireRole, loadConfig, findAll } = require('./lib/core');
const { merchantAccounts } = require('./lib/mobileMoney');
const { resolveRange, previousRange, bucketOf, bucketKeys, localClock } = require('./lib/dates');
const R = require('./lib/reports');
const { orderRiderPay } = require('./lib/money');
const { placedAt, createdIn } = require('./lib/placed');
const { payOwed } = require('./payouts');
const { branchParam } = require('./branches');

const MAX_ROWS = 2000;
const PERIODS = ['day', 'week', 'month'];

const nameOf = (user) =>
  user
    ? [
        user.get('riderCode') || user.get('cashierCode') || user.get('financeCode'),
        user.get('name') || user.get('username'),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

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

const METHODS = ['all', 'cash', 'mobile_money', 'card'];
function methodOf(params) {
  const method = params.method || 'all';
  if (!METHODS.includes(method)) throw invalid('Payment type must be cash, mobile_money or card');
  return method;
}

function periodOf(params, range) {
  if (params.period) {
    if (!PERIODS.includes(params.period)) throw invalid('Group by day, week or month');
    return params.period;
  }
  return range.days <= 31 ? 'day' : range.days <= 120 ? 'week' : 'month';
}

// Orders whose `field` falls inside the range (optionally one rider's, and
// one branch's: a Branch from branchParam).
function ordersIn(range, field, riderId, branch) {
  // Placed time counts restored orders by their original time (lib/placed.js).
  const query = field === 'createdAt' ? createdIn('Order', range) : new Parse.Query('Order');
  if (field !== 'createdAt') {
    query.greaterThanOrEqualTo(field, range.start);
    query.lessThan(field, range.end);
  }
  const rider = riderPointer(riderId);
  if (rider) query.equalTo('createdBy', rider);
  if (branch) query.equalTo('branch', branch);
  query.include('createdBy');
  return query;
}

function factOf(order) {
  const rider = order.get('createdBy');
  const phone = order.get('customerPhone');
  const name = String(order.get('customerName') || '').toLowerCase();
  // Walk-in guests without a phone ("Eat-in guest", "Pick-up") are not known
  // customers; only riders' named customers are matched by name.
  const fromCounter = order.get('source') === 'counter';
  return {
    id: order.id,
    code: order.get('orderCode'),
    status: order.get('status'),
    restaurantStatus: order.get('restaurantStatus'),
    channel: order.get('channel'),
    orderType: order.get('orderType') || 'delivery',
    source: order.get('source') || 'rider',
    customer: order.get('customerName') || '',
    customerKey:
      order.get('customer')?.id ||
      (phone ? `tel:${phone}` : !fromCounter && name ? `name:${name}` : ''),
    riderId: rider?.id || '',
    rider: nameOf(rider),
    branchId: order.get('branch')?.id || '',
    // The sale: what the customer paid plus any voucher they paid with
    // (vouchers.js); `voucher` is that part, no new money.
    total: Number(order.get('total') || 0) + Number(order.get('voucherAmount') || 0),
    voucher: Number(order.get('voucherAmount') || 0),
    subtotal: Number(order.get('subtotal') || 0),
    deliveryFee: Number(order.get('deliveryFee') || 0),
    deliveryPay: Number(order.get('deliveryPay') ?? order.get('deliveryFee') ?? 0),
    // Rider pay: commission + delivery fee, taken off revenue like commission.
    commission: order.get('status') === 'DELIVERED' ? orderRiderPay(order) : 0,
    method: order.get('paymentMethod'),
    provider: order.get('paymentProvider') || '',
    reference: order.get('paymentReference') || '',
    paymentStatus: order.get('paymentStatus') || '',
    amountCollected: Number(order.get('amountCollected') || 0),
    cashStatus: order.get('cashStatus') || '',
    createdAt: placedAt(order),
    deliveredAt: order.get('deliveredAt') || null,
  };
}

const byNewest = (field) => (a, b) => (b[field] || 0) - (a[field] || 0);
const rangeInfo = (range) => ({ from: range.from, to: range.to, days: range.days });

// Riders for the filter drop-downs (everyone who has ever had a rider code).
Parse.Cloud.define('getReportOptions', async (request) => {
  await requireRole(request, ['cashier', 'admin', 'finance']);
  const query = new Parse.Query(Parse.User);
  query.exists('riderCode');
  const riders = (await findAll(query)).sort((a, b) =>
    String(a.get('riderCode')).localeCompare(String(b.get('riderCode'))),
  );
  return {
    riders: riders.map((user) => ({
      id: user.id,
      label: nameOf(user),
      active: user.get('active') !== false,
    })),
  };
});

// Every cash collection, mobile money and card payment in the range, for
// reconciliation: cash by delivery date, mobile money and card by order date.
Parse.Cloud.define('getPaymentsLedger', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin', 'finance']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const method = methodOf(p);
  const wantCash = ['all', 'cash'].includes(method);
  const wantMomo = ['all', 'mobile_money'].includes(method);
  const wantCard = ['all', 'card'].includes(method);
  // Cashiers see their own branch; the owner and finance choose.
  const branch =
    role === 'cashier'
      ? (await user.fetch({ useMasterKey: true })).get('branch') || null
      : await branchParam(p.branchId);

  const cashQuery = ordersIn(range, 'deliveredAt', p.riderId, branch);
  cashQuery.equalTo('paymentMethod', 'cash');
  cashQuery.equalTo('status', 'DELIVERED');
  cashQuery.include('tillCashier');
  const momoQuery = ordersIn(range, 'createdAt', p.riderId, branch);
  momoQuery.equalTo('paymentMethod', 'mobile_money');
  momoQuery.include('paymentCheckedBy');
  // Card payments on the counter's card machine, checked like mobile money.
  const cardQuery = ordersIn(range, 'createdAt', p.riderId, branch);
  cardQuery.equalTo('paymentMethod', 'card');
  cardQuery.include('paymentCheckedBy');
  const handoverQuery = createdIn('CashHandover', {
    start: new Date(range.start.getTime() - 7 * 864e5),
    end: new Date(range.end.getTime() + 7 * 864e5),
  });
  if (p.riderId) handoverQuery.equalTo('rider', riderPointer(p.riderId));
  if (branch) handoverQuery.equalTo('branch', branch);
  handoverQuery.include(['rider', 'cashier']);

  const [cashOrders, momoOrders, cardOrders, handovers] = await Promise.all([
    wantCash ? findAll(cashQuery) : [],
    wantMomo ? findAll(momoQuery) : [],
    wantCard && !p.riderId ? findAll(cardQuery) : [],
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
      // Eat-in / pick-up cash was taken at the counter, not by a rider.
      rider: f.rider || `Counter · ${nameOf(order.get('tillCashier'))}`,
      customer: f.customer,
      amount: f.amountCollected,
      orderTotal: f.total,
      status: f.cashStatus,
      provider: '',
      reference: handoverOf.get(order.id) || '',
      note: order.get('shortfallNote') || '',
    };
  });
  const checkedRow = (kind) => (order) => {
    const f = factOf(order);
    return {
      id: f.id,
      kind,
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
  };
  const momoRows = momoOrders.map(checkedRow('mobile_money'));
  const cardRows = cardOrders.map(checkedRow('card'));

  const sum = (rows, test) => rows.filter(test).reduce((n, row) => n + row.amount, 0);
  const count = (rows, test) => rows.filter(test).length;
  // A pending payment on a cancelled order is no longer waiting for money.
  const live = (rows) =>
    rows.filter((r) => r.orderStatus !== 'CANCELLED' || r.status === 'VERIFIED');
  const liveMomo = live(momoRows);
  const liveCard = live(cardRows);
  const handoverRows = handovers
    .filter((h) => placedAt(h) >= range.start && placedAt(h) < range.end)
    .sort((a, b) => placedAt(b) - placedAt(a))
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
      createdAt: placedAt(h),
      confirmedAt: h.get('confirmedAt') || null,
      returnedAmount: Number(h.get('returnedAmount') || 0),
      shortage: Number(h.get('shortage') || 0),
      shortageStatus: h.get('shortageStatus') || '',
      resolutionNote: h.get('resolutionNote') || '',
      receivedByOwner: h.get('receivedByOwner') === true,
    }));
  const transactions = [...cashRows, ...momoRows, ...cardRows].sort(byNewest('at'));

  return {
    range: rangeInfo(range),
    method,
    summary: {
      total:
        sum(cashRows, () => true) +
        sum(liveMomo, (r) => r.status === 'VERIFIED') +
        sum(liveCard, (r) => r.status === 'VERIFIED'),
      cash: {
        count: cashRows.length,
        collected: sum(cashRows, () => true),
        withRiders: sum(cashRows, (r) => r.status === 'WITH_RIDER'),
        handoverPending: sum(cashRows, (r) => r.status === 'HANDOVER_PENDING'),
        reconciled: sum(cashRows, (r) => r.status === 'RECONCILED'),
        // Taken at the counter (eat-in / pick-up), straight into a till.
        inTill: sum(cashRows, (r) => r.status === 'IN_TILL'),
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
      card: {
        count: cardRows.length,
        verified: sum(cardRows, (r) => r.status === 'VERIFIED'),
        verifiedCount: count(cardRows, (r) => r.status === 'VERIFIED'),
        pending: sum(liveCard, (r) => r.status === 'PENDING_VERIFICATION'),
        pendingCount: count(liveCard, (r) => r.status === 'PENDING_VERIFICATION'),
        rejectedCount: count(cardRows, (r) => r.status === 'REJECTED'),
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
// Orders table filters beyond dates / rider / payment / status.
const ORDER_CHANNELS = ['walkin', 'phone', 'whatsapp', 'other'];
const CASH_STATUSES = [
  'NOT_COLLECTED',
  'WITH_RIDER',
  'HANDOVER_PENDING',
  'RECONCILED',
  'IN_TILL',
  'UNPAID',
  'REFUNDED',
  'NOT_APPLICABLE',
];

// Owner: orders in a range. Filters: riderId, method, status, channel,
// cashStatus. The summary covers every match; rows come 2,000 per `page`
// (0 = newest).
Parse.Cloud.define('adminSearchOrders', async (request) => {
  await requireRole(request, ['admin', 'finance']);
  const p = request.params;
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const method = methodOf(p);
  const query = ordersIn(range, 'createdAt', p.riderId, await branchParam(p.branchId));
  if (method !== 'all') query.equalTo('paymentMethod', method);
  if (p.status) {
    if (!ORDER_STATUSES.includes(p.status)) throw invalid('Unknown status filter');
    if (p.status === 'open')
      query.containedIn('status', ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP']);
    else query.equalTo('status', p.status);
  }
  if (p.channel) {
    if (!ORDER_CHANNELS.includes(p.channel)) throw invalid('Unknown channel filter');
    query.equalTo('channel', p.channel);
  }
  if (p.cashStatus) {
    if (!CASH_STATUSES.includes(p.cashStatus)) throw invalid('Unknown cash status filter');
    query.equalTo('cashStatus', p.cashStatus);
  }
  const page = Number(p.page ?? 0);
  if (!Number.isInteger(page) || page < 0) throw invalid('Invalid page');
  const facts = (await findAll(query)).map(factOf).sort(byNewest('createdAt'));
  const pages = Math.max(1, Math.ceil(facts.length / MAX_ROWS));
  return {
    range: rangeInfo(range),
    summary: R.summarize(facts),
    rows: facts
      .slice(page * MAX_ROWS, (page + 1) * MAX_ROWS)
      .map(({ customerKey: _key, ...row }) => row),
    page,
    pages,
    pageSize: MAX_ROWS,
    totalRows: facts.length,
    truncated: page + 1 < pages,
  };
});

// Rider pay earned on deliveries in the range, with a total per rider and
// what is paid or still owed. `paid`: 'all' (default), 'paid' or 'owed'.
const PAID_FILTERS = ['all', 'paid', 'owed'];
Parse.Cloud.define('getCommissionLedger', async (request) => {
  await requireRole(request, ['admin', 'finance']);
  const p = request.params;
  const paidFilter = p.paid || 'all';
  if (!PAID_FILTERS.includes(paidFilter)) throw invalid('Show all, paid or owed');
  const { values: config } = await loadConfig();
  const range = rangeOf(p, config, { defaultDays: 7 });
  const query = ordersIn(range, 'deliveredAt', p.riderId, await branchParam(p.branchId));
  query.equalTo('status', 'DELIVERED');
  // Rider deliveries only: eat-in and pick-up orders have no rider pay.
  query.exists('createdBy');
  const all = (await findAll(query))
    .map((order) => {
      const fact = factOf(order);
      const owed = order.get('commissionPaid') === true ? 0 : payOwed(order);
      return {
        ...fact,
        owed,
        payState: owed === 0 ? 'paid' : owed < fact.commission ? 'part' : 'owed',
      };
    })
    .sort(byNewest('deliveredAt'));
  const facts =
    paidFilter === 'all'
      ? all
      : all.filter((f) => (paidFilter === 'paid' ? f.payState === 'paid' : f.owed > 0));
  const owedBy = new Map();
  for (const f of facts) owedBy.set(f.riderId, (owedBy.get(f.riderId) || 0) + f.owed);
  const riders = R.riderStats(facts).sort((a, b) => b.commission - a.commission);
  const total = facts.reduce((n, f) => n + f.commission, 0);
  const owed = facts.reduce((n, f) => n + f.owed, 0);
  return {
    range: rangeInfo(range),
    paid: paidFilter,
    total,
    owed,
    paidOut: total - owed,
    deliveries: facts.length,
    riders: riders.map(({ riderId, rider, delivered, revenue, commission }) => ({
      riderId,
      rider,
      deliveries: delivered,
      sales: revenue,
      commission,
      owed: owedBy.get(riderId) || 0,
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
      owed: f.owed,
      payState: f.payState,
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
  const { user, role } = await requireRole(request, ['rider', 'admin', 'finance']);
  const p = request.params;
  const riderId = role === 'rider' ? user.id : p.riderId || user.id;
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
        accompanimentPrices: item.get('accompanimentPrices') || [],
      });
  }
  return lines;
}

// The owner's report: revenue over time, growth against the previous period
// and month on month, menu item sales, riders, payment mix and busy hours.
Parse.Cloud.define('getOperationsReport', async (request) => {
  await requireRole(request, ['admin', 'finance']);
  if ((await require('./lib/limits').features()).reports === false)
    throw invalid('Reports are not part of your plan');
  const p = request.params;
  const { values: config } = await loadConfig();
  const tz = config.timezone;
  const range = rangeOf(p, config, { defaultDays: 30 });
  const period = periodOf(p, range);
  const before = previousRange(range, tz);
  const branch = await branchParam(p.branchId);
  const [facts, previousFacts, branches] = await Promise.all([
    findAll(ordersIn(range, 'createdAt', p.riderId, branch)).then((rows) => rows.map(factOf)),
    findAll(ordersIn(before, 'createdAt', p.riderId, branch)).then((rows) => rows.map(factOf)),
    findAll(new Parse.Query('Branch')),
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
    // Sales per branch (when the restaurant has more than one).
    branches:
      branches.length > 1
        ? R.branchMix(facts, Object.fromEntries(branches.map((b) => [b.id, b.get('name')])))
        : [],
    ...R.timeOfDay(facts, (f) => localClock(f.createdAt, tz)),
  };
});

module.exports = { factOf, findAll, ordersIn, orderLines };
