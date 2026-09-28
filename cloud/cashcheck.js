// Cash check: confirms the cash records still agree with each other and tells
// the owner about anything that does not. Runs once a day with the rest of the
// daily upkeep: on the first staff activity of the day (no scheduled job
// needed), or as the Cloud Job "cashCheck" if one is scheduled, and on demand
// from the owner's Payments ledger.

const { adminOnly, claimOnce, loadConfig, findAll } = require('./lib/core');
const { due } = require('./lib/throttle');
const { log, errorMessage } = require('./lib/log');
const { sumBy } = require('./lib/money');
const { dateKey } = require('./lib/dates');
const { money, notifyAdmins } = require('./notifications');

const OPEN_SHIFT_HOURS = 16;

async function runCashCheck() {
  const { values: config } = await loadConfig();
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const problems = [];
  const add = (kind, message) => problems.push({ kind, message });

  const handovers = await findAll(
    new Parse.Query('CashHandover').greaterThanOrEqualTo('handedOverAt', since),
  );
  const inHandover = new Map(); // order id -> [handover, …] still waiting
  const confirmedOrders = new Set();
  for (const row of handovers) {
    const ids = (row.get('orders') || []).map((ptr) => ptr.id);
    const returned = new Set((row.get('returnedOrders') || []).map((ptr) => ptr.id));
    if (['pending', 'disputed'].includes(row.get('status')))
      for (const id of ids) inHandover.set(id, [...(inHandover.get(id) || []), row]);
    if (row.get('status') === 'confirmed')
      for (const id of ids) if (!returned.has(id)) confirmedOrders.add(id);
  }

  const orders = await findAll(
    new Parse.Query('Order')
      .equalTo('status', 'DELIVERED')
      .equalTo('paymentMethod', 'cash')
      .greaterThanOrEqualTo('deliveredAt', since),
  );
  const byId = new Map(orders.map((order) => [order.id, order]));
  for (const order of orders) {
    const code = order.get('orderCode');
    const status = order.get('cashStatus');
    const waiting = inHandover.get(order.id) || [];
    if (status === 'HANDOVER_PENDING' && waiting.length !== 1)
      add(
        'order_handover',
        waiting.length
          ? `${code} is in ${waiting.length} handovers at once`
          : `${code} is marked as handed over but is in no waiting handover`,
      );
    if (status === 'RECONCILED' && !confirmedOrders.has(order.id))
      add('order_reconciled', `${code} is marked as received but no confirmed handover has it`);
    if (status === 'WITH_RIDER' && waiting.length)
      add('order_with_rider', `${code} is with the rider but also in a waiting handover`);
  }

  for (const row of handovers) {
    if (row.get('status') !== 'pending') continue;
    const code = row.get('handoverCode');
    const rowOrders = (row.get('orders') || []).map((ptr) => byId.get(ptr.id)).filter(Boolean);
    if (rowOrders.some((order) => order.get('cashStatus') !== 'HANDOVER_PENDING'))
      add('handover_orders', `${code} has orders that are no longer waiting for it`);
    const sum = sumBy(rowOrders, (order) => order.get('amountCollected'));
    if (rowOrders.length === (row.get('orders') || []).length && sum !== row.get('amount'))
      add(
        'handover_amount',
        `${code} claims ${money(config, row.get('amount'))} but its orders add up to ${money(config, sum)}`,
      );
  }

  const staleShifts = await findAll(
    new Parse.Query('Shift')
      .equalTo('status', 'open')
      .lessThan('startedAt', new Date(Date.now() - OPEN_SHIFT_HOURS * 3600 * 1000))
      .include('operator'),
  );
  for (const shift of staleShifts)
    add(
      'shift_open',
      `${shift.get('operator')?.get('name') || 'A team member'}'s ${shift.get('kind')} shift has been open for over ${OPEN_SHIFT_HOURS} hours`,
    );

  const checkedAt = new Date();
  if (problems.length)
    await notifyAdmins({
      kind: 'cash.check',
      tone: 'alert',
      key: `cash-check:${dateKey(checkedAt, config.timezone)}:${problems.length}`,
      title: `Cash check: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`,
      body: problems
        .slice(0, 3)
        .map((p) => p.message)
        .join(' · '),
      link: '/admin/payments',
    });
  return { checkedAt, ok: !problems.length, problems };
}

// The daily upkeep: the cash check, removing customer details past the
// owner's retention period (Admin → Data & privacy), and checking the
// server's public address (Airtel's allowed list).
async function upkeep() {
  const result = await runCashCheck();
  const retention = await require('./privacy').runRetention();
  await require('./serverAddress')
    .watchServerAddress()
    .catch(() => null);
  return { result, retention };
}

// Once a day without a scheduled job: the first staff activity of the day
// (their notification check) starts the upkeep in the background. The day is
// claimed in the database, so only one server does it.
const upkeepCheckMs = () => Number(process.env.RELAY_UPKEEP_CHECK_MS ?? 600000);
function upkeepDue() {
  if (!due('upkeep', upkeepCheckMs())) return;
  void (async () => {
    const { values: config } = await loadConfig();
    if (!(await claimOnce(`upkeep:${dateKey(new Date(), config.timezone)}`))) return;
    const { result } = await upkeep();
    log('info', 'upkeep.done', { problems: result.problems.length });
  })().catch((error) => log('error', 'upkeep.failed', { message: errorMessage(error) }));
}

Parse.Cloud.job('cashCheck', async () => {
  const { result, retention } = await upkeep();
  const cleaned = retention.orders || retention.customers || retention.notifications;
  return `${result.ok ? 'Cash records agree' : `${result.problems.length} problems found`}${
    cleaned
      ? `; customer details removed from ${retention.orders} orders, ${retention.customers} customers`
      : ''
  }`;
});

Parse.Cloud.define('adminRunCashCheck', async (request) => {
  await adminOnly(request);
  return runCashCheck();
});

module.exports = { runCashCheck, upkeepDue };
