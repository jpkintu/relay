// Relay Hosted: restaurants pay their Relay subscription with mobile money
// through ioTec Pay, or you record a payment received by hand
// (docs/HOSTED.md). One SubscriptionPayment row per attempt.

const { MASTER, audit, claimOnce, invalid, readAcl, requireRole } = require('./lib/core');
const tenancy = require('./lib/tenant');
const iotec = require('./lib/iotec');
const { log } = require('./lib/log');
const { due } = require('./lib/throttle');
const { accessOf, addMonths } = require('./lib/access');
const { notifyAdmins } = require('./notifications');
const {
  platformSettings,
  requirePlatform,
  restaurantSummary,
  priceOf,
  forEachRestaurant,
} = require('./restaurants');

const MONTHS = [1, 3, 6, 12];
// ioTec's smallest collection.
const MIN_AMOUNT = 500;
// A prompt nobody answers is given up after this long.
const ANSWER_MS = 30 * 60000;
const DAY = 86400000;
// Owners are reminded this many days before the trial or paid month ends.
const REMIND_DAYS = 3;

async function restaurantRow(id = tenancy.current()) {
  return tenancy.withoutTenant(() => new Parse.Query('Restaurant').get(id, MASTER));
}

function toJSON(row) {
  return {
    id: row.id,
    createdAt: row.createdAt?.toISOString() || null,
    amount: row.get('amount'),
    currency: row.get('currency'),
    months: row.get('months'),
    method: row.get('method'),
    status: row.get('status'),
    payer: row.get('payer') || '',
    message: row.get('message') || '',
    reference: row.get('reference') || '',
    periodStart: row.get('periodStart')?.toISOString() || null,
    periodEnd: row.get('periodEnd')?.toISOString() || null,
    paidAt: row.get('paidAt')?.toISOString() || null,
  };
}

// Marks a payment paid and moves the restaurant's paid-until date on by its
// months, from the later of today, the trial end and the current paid-until
// date, so a late or repeated answer can never shorten it. Runs once per
// payment, however many checks see "Success" at the same time.
async function settle(payment, { reference = '', message = '' } = {}) {
  if (!(await tenancy.withoutTenant(() => claimOnce(`subscription-payment:${payment.id}`))))
    return payment.fetch(MASTER);
  const row = await restaurantRow(payment.get('tenant').id);
  const base = new Date(
    Math.max(
      Date.now(),
      row.get('trialEndsAt')?.getTime() || 0,
      row.get('paidUntil')?.getTime() || 0,
    ),
  );
  const end = addMonths(base, Number(payment.get('months')) || 1);
  row.set('paidUntil', end);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  tenancy.clearCache();
  payment.set({
    status: 'paid',
    reference: reference || payment.get('reference') || '',
    message: message || 'Paid',
    periodStart: base,
    periodEnd: end,
    paidAt: new Date(),
  });
  await payment.save(null, MASTER);
  log('info', 'billing.paid', {
    restaurant: row.id,
    payment: payment.id,
    amount: payment.get('amount'),
    until: end.toISOString(),
  });
  return payment;
}

// Asks ioTec how a pending payment went and records the answer.
async function refresh(payment) {
  if (payment.get('status') !== 'pending' || payment.get('method') !== 'iotec') return payment;
  const id = payment.get('providerId');
  const age = Date.now() - payment.createdAt.getTime();
  if (id) {
    try {
      const result = await iotec.checkStatus(id);
      if (result.status === 'paid') return settle(payment, result);
      if (result.status === 'failed') {
        payment.set({ status: 'failed', message: result.message || 'Not paid' });
        await payment.save(null, MASTER);
        return payment;
      }
    } catch (error) {
      payment.set('message', `Could not check with ioTec: ${String(error.message).slice(0, 150)}`);
    }
  }
  if (age > ANSWER_MS) {
    payment.set({ status: 'failed', message: 'Nobody approved it on the phone in 30 minutes' });
    await payment.save(null, MASTER);
  } else if (payment.dirty()) await payment.save(null, MASTER);
  return payment;
}

async function pendingPayments() {
  const query = new Parse.Query('SubscriptionPayment');
  query.equalTo('status', 'pending');
  query.limit(100);
  return query.find(MASTER);
}

async function history(limit = 20) {
  const query = new Parse.Query('SubscriptionPayment');
  query.descending('createdAt');
  query.limit(limit);
  return query.find(MASTER);
}

async function billingState() {
  for (const payment of await pendingPayments()) await refresh(payment);
  const row = await restaurantRow();
  return {
    restaurant: await restaurantSummary(),
    // False until the ioTec keys are set in the Back4App app.
    payInApp: iotec.configured(),
    sandbox: iotec.sandbox(),
    billingPhone: row.get('billingPhone') || '',
    months: MONTHS,
    payments: (await history()).map(toJSON),
  };
}

// Owner: the subscription, whether paying in the app is on, and past
// payments. Open when the restaurant is expired (restaurants.js).
Parse.Cloud.define('getBilling', async (request) => {
  await requireRole(request, ['admin']);
  return billingState();
});

// Owner: move to another plan { plan }. Upgrading is immediate; moving down
// to Basic needs the restaurant within Basic's limits. The new price applies
// from the next payment.
Parse.Cloud.define('changePlan', async (request) => {
  const { user: actor } = await requireRole(request, ['admin']);
  const plan = request.params?.plan;
  const limits = require('./lib/limits');
  if (!limits.PLANS[plan]) throw invalid('Choose Basic or Enterprise');
  const row = await restaurantRow();
  const before = limits.planOf(row);
  if (before === plan) throw invalid(`You are on ${limits.PLANS[plan].label} already`);
  if (plan === 'basic') {
    const problems = await limits.overLimits('basic');
    if (problems.length) throw invalid(`Basic allows less than you have: ${problems.join(', ')}`);
  }
  row.set('plan', plan);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  await audit(actor, 'subscription.plan_changed', row, { plan: before }, { plan });
  return billingState();
});

// Owner: pay { months, phone } with mobile money. ioTec asks the phone to
// approve; checkSubscriptionPayment follows it up.
Parse.Cloud.define('startSubscriptionPayment', async (request) => {
  const { user } = await requireRole(request, ['admin']);
  const p = request.params || {};
  const { values: platform } = await platformSettings();
  if (!iotec.configured())
    throw invalid(
      `Paying in the app is not switched on yet. Contact Relay${
        platform.supportContact ? ` (${platform.supportContact})` : ''
      } to renew`,
    );
  const months = Number(p.months);
  if (!MONTHS.includes(months)) throw invalid(`Choose ${MONTHS.join(', ')} months`);
  const phone = String(p.phone || '').replace(/[^\d+]/g, '');
  if (phone.replace(/\D/g, '').length < 9)
    throw invalid('Enter the mobile money number to pay from');
  const row = await restaurantRow();
  const amount = priceOf(row, platform) * months;
  if (amount < MIN_AMOUNT) throw invalid('Nothing to pay at this price. Contact Relay');

  for (const waiting of await pendingPayments()) {
    await refresh(waiting);
    if (waiting.get('status') === 'pending')
      throw invalid(
        `A payment is already waiting for approval on ${waiting.get('payer')}. Approve it there, or wait a few minutes`,
      );
  }

  const payment = new Parse.Object('SubscriptionPayment');
  payment.set({
    amount,
    currency: platform.currency,
    months,
    method: 'iotec',
    status: 'pending',
    payer: phone,
    externalId: `relay-${row.get('code')}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    recordedBy: user,
  });
  payment.setACL(readAcl(null, ['admin']));
  await payment.save(null, MASTER);
  try {
    const result = await iotec.collect({
      externalId: payment.get('externalId'),
      amount,
      currency: platform.currency,
      payer: phone,
      payerName: row.get('ownerName') || row.get('name'),
      note: `Relay for ${row.get('name')}: ${months} month${months === 1 ? '' : 's'}`.slice(0, 100),
    });
    payment.set({ providerId: result.id, message: result.message || 'Waiting for approval' });
    if (result.status === 'failed') payment.set('status', 'failed');
    await payment.save(null, MASTER);
    if (result.status === 'paid') await settle(payment, result);
  } catch (error) {
    payment.set({
      status: 'failed',
      message: `ioTec refused the request: ${String(error.message).slice(0, 150)}`,
    });
    await payment.save(null, MASTER);
  }
  if (row.get('billingPhone') !== phone) {
    row.set('billingPhone', phone);
    await tenancy.withoutTenant(() => row.save(null, MASTER));
  }
  await audit(user, 'billing.payment_started', payment, null, toJSON(payment));
  return toJSON(payment);
});

// Owner: how a payment is going. { id } → { payment, restaurant }
Parse.Cloud.define('checkSubscriptionPayment', async (request) => {
  await requireRole(request, ['admin']);
  const payment = await new Parse.Query('SubscriptionPayment')
    .get(String(request.params?.id || ''), MASTER)
    .catch(() => null);
  if (!payment) throw invalid('Payment not found');
  await refresh(payment);
  return { payment: toJSON(payment), restaurant: await restaurantSummary() };
});

// Platform: record a payment received by hand (cash, bank, a mobile money
// transfer). { id (restaurant), months, amount?, reference?, note? }
Parse.Cloud.define('platformRecordPayment', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const row = await tenancy
    .withoutTenant(() => new Parse.Query('Restaurant').get(String(p.id || ''), MASTER))
    .catch(() => null);
  if (!row) throw invalid('Restaurant not found');
  const months = Number(p.months);
  if (!Number.isInteger(months) || months < 1 || months > 24) throw invalid('Months: 1 to 24');
  const { values: platform } = await platformSettings();
  const amount =
    p.amount === undefined || p.amount === '' ? priceOf(row, platform) * months : Number(p.amount);
  if (!Number.isFinite(amount) || amount < 0) throw invalid('Amount: a number from 0 up');
  const payment = await tenancy.runAs(
    row.id,
    async () => {
      const created = new Parse.Object('SubscriptionPayment');
      created.set({
        amount: Math.round(amount),
        currency: platform.currency,
        months,
        method: 'manual',
        status: 'pending',
        reference: String(p.reference || '')
          .trim()
          .slice(0, 100),
        note: String(p.note || '')
          .trim()
          .slice(0, 200),
        recordedBy: actor,
      });
      created.setACL(readAcl(null, ['admin']));
      await created.save(null, MASTER);
      return settle(created, { message: 'Recorded by Relay' });
    },
    row.get('code'),
  );
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.payment_recorded', row, null, {
      amount: payment.get('amount'),
      months,
      reference: payment.get('reference'),
      paidUntil: payment.get('periodEnd'),
    }),
  );
  return toJSON(payment);
});

// Platform: recent payments, for one restaurant ({ id }) or all.
Parse.Cloud.define('platformListPayments', async (request) => {
  await requirePlatform(request);
  const query = new Parse.Query('SubscriptionPayment');
  if (request.params?.id)
    query.equalTo('tenant', {
      __type: 'Pointer',
      className: 'Restaurant',
      objectId: String(request.params.id),
    });
  query.descending('createdAt');
  query.limit(100);
  query.include('tenant');
  const rows = await tenancy.withoutTenant(() => query.find(MASTER));
  return {
    rows: rows.map((row) => ({
      ...toJSON(row),
      restaurantId: row.get('tenant')?.id || '',
      restaurant: row.get('tenant')?.get('name') || '',
    })),
  };
});

// Reminds the owner before the trial or paid month ends, and when it has
// ended (once per date; notifications carry a key).
async function remind(row, platform) {
  const access = accessOf(row, platform.graceDays);
  const until = access.until;
  if (!until) return 0;
  const left = Math.ceil((until.getTime() - Date.now()) / DAY);
  const price = `${platform.currency} ${priceOf(row, platform).toLocaleString('en-US')}`;
  const day = until.toISOString().slice(0, 10);
  if ((access.status === 'trial' || access.status === 'active') && left <= REMIND_DAYS)
    return notifyAdmins({
      kind: 'billing.reminder',
      tone: 'warning',
      title:
        access.status === 'trial'
          ? `Your free trial ends in ${left} day${left === 1 ? '' : 's'}`
          : `Your Relay month ends in ${left} day${left === 1 ? '' : 's'}`,
      body: `Pay ${price} a month from Overview to keep Relay open.`,
      link: '/admin',
      key: `billing:${access.status}:${day}`,
    });
  if (access.status === 'past_due')
    return notifyAdmins({
      kind: 'billing.reminder',
      tone: 'alert',
      title: `Relay closes in ${left} day${left === 1 ? '' : 's'}`,
      body: `Your subscription has ended. Pay ${price} from Overview to keep the app open.`,
      link: '/admin',
      key: `billing:past_due:${day}`,
    });
  return 0;
}

// Without the billing job (Back4App's scheduler is a paid feature): whenever
// the restaurant's owner has the app open (their notification check), follow
// up its waiting payments and send any reminder due, at most every few
// minutes per restaurant, in the background.
const billingCheckMs = () => Number(process.env.RELAY_BILLING_CHECK_MS ?? 300000);
function billingDue() {
  const tenant = tenancy.current();
  if (!tenant || !due('billing', billingCheckMs())) return;
  void (async () => {
    for (const payment of await pendingPayments()) await refresh(payment);
    const { values: platform } = await platformSettings();
    await remind(await restaurantRow(tenant), platform);
  })().catch((error) =>
    log('warn', 'billing.check_failed', { restaurant: tenant, message: String(error?.message) }),
  );
}

// Job: every few minutes (Back4App → Cloud Code → Jobs → schedule "billing").
// Follows up pending ioTec payments and sends the owners' reminders.
Parse.Cloud.job('billing', async () => {
  const { values: platform } = await platformSettings();
  let checked = 0;
  let reminded = 0;
  await forEachRestaurant(async (row) => {
    for (const payment of await pendingPayments()) {
      await refresh(payment);
      checked += 1;
    }
    reminded += await remind(row, platform);
  });
  return `${checked} payments checked, ${reminded} reminders sent`;
});

module.exports = { billingDue };
