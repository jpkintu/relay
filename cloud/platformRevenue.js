// Relay Hosted: the platform's own revenue, for the console dashboard. Money
// received (paid SubscriptionPayment rows) by month, what the paying
// restaurants bring in each month, how trials turn into payments, and who
// pays next or is late. Read only; computed on each request.

const { MASTER } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { accessOf } = require('./lib/access');
const { requirePlatform, platformSettings, priceOf } = require('./restaurants');

const DAY = 86400000;
const TIME_ZONE = process.env.RELAY_EMAIL_TZ || 'Africa/Kampala';
const monthKey = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' })
    .format(date)
    .slice(0, 7);
// The last `count` months, oldest first, as YYYY-MM.
function lastMonths(count, now = new Date()) {
  const [year, month] = monthKey(now).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - (count - 1 - i), 15));
    return d.toISOString().slice(0, 7);
  });
}

Parse.Cloud.define('platformRevenue', async (request) => {
  await requirePlatform(request);
  const { values: platform } = await platformSettings();
  const now = Date.now();
  const [restaurants, payments] = await tenancy.withoutTenant(() =>
    Promise.all([
      new Parse.Query('Restaurant').findAll({ ...MASTER, batchSize: 500 }),
      new Parse.Query('SubscriptionPayment')
        .equalTo('status', 'paid')
        .findAll({ ...MASTER, batchSize: 1000 }),
    ]),
  );

  // Money received, by the month it was paid.
  const months = lastMonths(12);
  const byMonth = Object.fromEntries(months.map((key) => [key, { amount: 0, payments: 0 }]));
  const everPaid = new Set();
  let allTime = 0;
  for (const payment of payments) {
    const amount = Number(payment.get('amount')) || 0;
    allTime += amount;
    everPaid.add(payment.get('tenant')?.id);
    const key = monthKey(payment.get('paidAt') || payment.createdAt);
    if (byMonth[key]) {
      byMonth[key].amount += amount;
      byMonth[key].payments += 1;
    }
  }

  const planName = Object.fromEntries((platform.plans || []).map((p) => [p.key, p.name]));
  const status = { trial: 0, active: 0, past_due: 0, expired: 0, suspended: 0 };
  const plans = {};
  const upcoming = [];
  const overdue = [];
  let mrr = 0;
  let trialEnded = 0;
  for (const row of restaurants) {
    const access = accessOf(row, platform.graceDays, now);
    status[access.status] = (status[access.status] || 0) + 1;
    const price = priceOf(row, platform);
    const base = {
      id: row.id,
      name: row.get('name'),
      code: row.get('code'),
      plan: planName[row.get('plan')] || row.get('plan') || '',
      amount: price,
    };
    const paying = access.status === 'active' || access.status === 'past_due';
    if (paying) {
      mrr += price;
      const key = row.get('plan') || '';
      plans[key] = plans[key] || { name: base.plan, restaurants: 0, mrr: 0 };
      plans[key].restaurants += 1;
      plans[key].mrr += price;
    }
    const trialEnd = row.get('trialEndsAt')?.getTime() || 0;
    if (everPaid.has(row.id) || (trialEnd && trialEnd < now)) trialEnded += 1;
    const until = access.until?.getTime() || 0;
    if ((access.status === 'trial' || access.status === 'active') && until - now <= 30 * DAY)
      upcoming.push({
        ...base,
        kind: access.status === 'trial' ? 'trial_ends' : 'renewal',
        dueAt: new Date(until).toISOString(),
      });
    if (access.status === 'past_due')
      overdue.push({
        ...base,
        dueAt: new Date(until - Number(platform.graceDays || 0) * DAY).toISOString(),
        closesAt: new Date(until).toISOString(),
      });
  }
  upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  overdue.sort((a, b) => a.closesAt.localeCompare(b.closesAt));

  const thisKey = months[11];
  const lastKey = months[10];
  const converted = restaurants.filter((row) => everPaid.has(row.id)).length;
  return {
    currency: platform.currency,
    months: months.map((key) => ({ month: key, ...byMonth[key] })),
    thisMonth: byMonth[thisKey].amount,
    lastMonth: byMonth[lastKey].amount,
    allTime,
    // Monthly recurring revenue: what the paying restaurants pay a month.
    mrr,
    restaurants: restaurants.length,
    status,
    plans: Object.values(plans).sort((a, b) => b.mrr - a.mrr),
    // Trial to paid: restaurants that ever paid, of those whose trial ended
    // (or who paid without one).
    conversion: { converted, eligible: trialEnded },
    upcoming,
    dueIn30Days: upcoming.reduce((sum, row) => sum + row.amount, 0),
    overdue,
    overdueAmount: overdue.reduce((sum, row) => sum + row.amount, 0),
  };
});

module.exports = { lastMonths, monthKey };
