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
  annualPriceOf,
  renewalPlanOf,
  planOfRow,
  forEachRestaurant,
} = require('./restaurants');
const { dateText, moneyText } = require('./lib/emailTemplates');
// Discount and referral codes on a first payment (offers.js; loaded late).
const offers = () => require('./offers');

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
    kind: row.get('kind') || 'period',
    plan: row.get('plan') || '',
    listAmount: row.get('listAmount') ?? null,
    discount: row.get('discount') || 0,
    discountCode: row.get('discountCode') || '',
  };
}

// A period paid on `target`: a bigger plan (or any plan when nothing paid is
// running) applies at once; a smaller one from the start of the new period,
// so the period already paid for stays on the plan it was paid on.
function applyPeriodPlan(row, target, start, plans) {
  const current = require('./lib/limits').planOf(row);
  if (target === current && !row.get('nextPlan')) return;
  const prices = Object.fromEntries((plans || []).map((plan) => [plan.key, plan.price]));
  const smaller = (prices[target] ?? 0) < (prices[current] ?? 0);
  if (smaller && start.getTime() > Date.now()) {
    row.set({ nextPlan: target, nextPlanFrom: start });
  } else {
    row.set('plan', target);
    row.unset('nextPlan');
    row.unset('nextPlanFrom');
  }
}

// Marks a payment paid and moves the restaurant's paid-until date on by its
// months, from the later of today, the trial end and the current paid-until
// date, so a late or repeated answer can never shorten it. Runs once per
// payment, however many checks see "Success" at the same time.
async function settle(payment, { reference = '', message = '' } = {}) {
  if (!(await tenancy.withoutTenant(() => claimOnce(`subscription-payment:${payment.id}`))))
    return payment.fetch(MASTER);
  const row = await restaurantRow(payment.get('tenant').id);
  const target = payment.get('plan') || '';
  let base;
  let end;
  if (payment.get('kind') === 'upgrade') {
    // An upgrade: the bigger plan from now to the end of the period already
    // paid for; the paid-until date stays.
    base = new Date();
    end = row.get('paidUntil') || base;
    row.set('plan', target);
    row.unset('nextPlan');
    row.unset('nextPlanFrom');
  } else {
    base = new Date(
      Math.max(
        Date.now(),
        row.get('trialEndsAt')?.getTime() || 0,
        row.get('paidUntil')?.getTime() || 0,
      ),
    );
    end = addMonths(base, Number(payment.get('months')) || 1);
    row.set('paidUntil', end);
    if (target) applyPeriodPlan(row, target, base, (await platformSettings()).values.plans);
  }
  // The first payment of a restaurant that chose to pay at sign-up: its code
  // is used now (offers.js).
  const offer = row.get('payFirst') === true ? row.get('offer') || null : null;
  if (row.get('payFirst') === true) {
    row.set('payFirst', false);
    row.unset('offer');
  }
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  if (offer) void offers().offerUsed(row, payment, offer);
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
  void emailPaid(row, payment);
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

// Invoices: every paid payment, and the next period while it is coming up
// (within INVOICE_DAYS of the end of the trial or paid period) or overdue.
const INVOICE_DAYS = 14;
const invoiceNumber = (row, suffix) => `INV-${row.get('code').toUpperCase()}-${suffix}`;
const nextInvoiceNumber = (row, end) =>
  invoiceNumber(row, end.toISOString().slice(0, 10).replace(/-/g, ''));
function invoicesOf(row, platform, payments) {
  const paid = payments
    .filter((p) => p.get('status') === 'paid')
    .map((p) => ({
      number: invoiceNumber(row, p.id),
      status: 'paid',
      issuedAt: (p.get('paidAt') || p.createdAt).toISOString(),
      dueAt: null,
      months: p.get('kind') === 'upgrade' ? 0 : Number(p.get('months')) || 1,
      kind: p.get('kind') || 'period',
      // The plan paid for (older payments: none recorded).
      planName: p.get('plan')
        ? require('./lib/plans').planFor(platform.plans || [], p.get('plan')).name
        : '',
      amount: Number(p.get('amount')) || 0,
      currency: p.get('currency') || platform.currency,
      periodStart: p.get('periodStart')?.toISOString() || null,
      periodEnd: p.get('periodEnd')?.toISOString() || null,
      paymentId: p.id,
      method: p.get('method') || 'iotec',
      payer: p.get('payer') || '',
      reference: p.get('reference') || '',
      listAmount: p.get('listAmount') ?? null,
      discount: p.get('discount') || 0,
      discountCode: p.get('discountCode') || '',
    }));
  const access = accessOf(row, platform.graceDays);
  const end = new Date(
    Math.max(row.get('trialEndsAt')?.getTime() || 0, row.get('paidUntil')?.getTime() || 0),
  );
  const daysLeft = Math.ceil((end.getTime() - Date.now()) / DAY);
  const next =
    access.status !== 'suspended' && end.getTime() > 0 && daysLeft <= INVOICE_DAYS
      ? [
          {
            number: nextInvoiceNumber(row, end),
            status: daysLeft < 0 ? 'overdue' : 'due',
            issuedAt: new Date(end.getTime() - INVOICE_DAYS * DAY).toISOString(),
            dueAt: end.toISOString(),
            months: 1,
            amount: priceOf(row, platform, renewalPlanOf(row, platform)),
            currency: platform.currency,
            periodStart: end.toISOString(),
            periodEnd: addMonths(end, 1).toISOString(),
            paymentId: null,
          },
        ]
      : [];
  return [...next, ...paid];
}

// Restaurants that signed up with this one's code, and what it earned.
async function referralsOf(row, platform) {
  const rows = await tenancy
    .withoutTenant(() =>
      new Parse.Query('Restaurant')
        .equalTo('referredBy', row.id)
        .descending('createdAt')
        .limit(200)
        .find(MASTER),
    )
    // The column only exists once a restaurant has signed up with a code.
    .catch(() => []);
  return {
    code: row.get('code'),
    percent: Number(platform.referralPercent) || 0,
    months: Number(platform.referralMonths) || 0,
    rows: rows.map((r) => ({
      name: r.get('name'),
      signedUpAt: r.createdAt?.toISOString() || null,
      // rewarded: paid, free months added; waiting: has not paid yet;
      // trial: chose the free trial instead (no reward).
      status: r.get('referralCredit') ? 'rewarded' : r.get('payFirst') ? 'waiting' : 'trial',
      months: r.get('referralCredit')?.months || 0,
      rewardedAt: r.get('referralCredit')?.at || null,
    })),
  };
}

function planState(row, platform, upgrades) {
  const current = planOfRow(row, platform);
  const renewal = renewalPlanOf(row, platform);
  const access = accessOf(row, platform.graceDays);
  return {
    current: current.key,
    currentName: current.name,
    renewal: renewal.key,
    renewalName: renewal.name,
    renewalFrom: row.get('nextPlan') ? row.get('nextPlanFrom')?.toISOString() || null : null,
    // While a paid period runs the period plan is fixed (change it under
    // Plans); otherwise the payment form offers every plan.
    choosePlanWhenPaying: access.status !== 'active' && !negotiated(row),
    negotiated: negotiated(row),
    upgrades,
  };
}

async function billingState() {
  for (const payment of await pendingPayments()) await refresh(payment);
  const row = await restaurantRow();
  const { values: platform } = await platformSettings();
  const payments = await history(100);
  // What each choice costs (12 months: the annual price), after a sign-up
  // code on the first payment.
  const priced = await offers().pricesFor(row, platform);
  const invoices = invoicesOf(row, platform, payments);
  const upgrades = {};
  for (const plan of platform.plans.filter((x) => x.active)) {
    const quote = await upgradeQuote(row, platform, plan);
    if (quote) upgrades[plan.key] = quote;
  }
  if (priced.offer && invoices[0] && invoices[0].status !== 'paid')
    Object.assign(invoices[0], {
      amount: priced.prices[1],
      listAmount: priced.listPrices[1],
      discount: priced.listPrices[1] - priced.prices[1],
      discountCode: priced.offer.code,
    });
  return {
    restaurant: await restaurantSummary(),
    prices: priced.prices,
    listPrices: priced.listPrices,
    planPrices: priced.planPrices,
    offer: priced.offer,
    // Plans: the one in force, the next period's, and what moving up now
    // costs while a paid period runs.
    plan: planState(row, platform, upgrades),
    referrals: await referralsOf(row, platform),
    invoices,
    // False until the ioTec keys are set in the Back4App app.
    payInApp: iotec.configured(),
    sandbox: iotec.sandbox(),
    billingPhone: row.get('billingPhone') || '',
    months: MONTHS,
    payments: payments.slice(0, 20).map(toJSON),
  };
}

// Owner: the subscription, whether paying in the app is on, and past
// payments. Open when the restaurant is expired (restaurants.js).
Parse.Cloud.define('getBilling', async (request) => {
  await requireRole(request, ['admin']);
  return billingState();
});

// Owner: choose the plan of the next period { plan }. A smaller plan starts
// when the period paid for ends (until then the restaurant keeps what it paid
// for); choosing the current plan again cancels that. Moving up is paid:
// startPlanUpgrade while a paid period runs, else a period payment on the
// bigger plan (startSubscriptionPayment { plan }).
Parse.Cloud.define('changePlan', async (request) => {
  const { user: actor } = await requireRole(request, ['admin']);
  const limits = require('./lib/limits');
  const { planOfRow } = require('./restaurants');
  const { values: platform } = await platformSettings();
  const target = platform.plans.find((plan) => plan.active && plan.key === request.params?.plan);
  if (!target) throw invalid('Choose one of the plans on offer');
  const row = await restaurantRow();
  if (negotiated(row))
    throw invalid('Your price was agreed with Relay. Contact Relay to change plan');
  const current = planOfRow(row, platform);
  const before = { plan: current.key, nextPlan: row.get('nextPlan') || '' };
  if (target.key === current.key) {
    if (!row.get('nextPlan')) throw invalid(`You are on ${target.name} already`);
    row.unset('nextPlan');
    row.unset('nextPlanFrom');
  } else if (target.price > current.price) {
    throw invalid(`Moving up to ${target.name} is paid: use Upgrade`);
  } else {
    const access = accessOf(row, platform.graceDays);
    if (access.status !== 'active' && access.status !== 'trial')
      throw invalid(`Choose ${target.name} when you pay your next period`);
    const problems = await limits.overLimits(target);
    if (problems.length)
      throw invalid(`${target.name} allows less than you have: ${problems.join(', ')}`);
    row.set({ nextPlan: target.key, nextPlanFrom: access.until });
  }
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  await audit(actor, 'subscription.plan_changed', row, before, {
    plan: current.key,
    nextPlan: row.get('nextPlan') || '',
  });
  return billingState();
});

const notConfigured = (platform) =>
  invalid(
    `Paying in the app is not switched on yet. Contact Relay${
      platform.supportContact ? ` (${platform.supportContact})` : ''
    } to pay`,
  );
const cleanPhone = (value) => {
  const phone = String(value || '').replace(/[^\d+]/g, '');
  if (phone.replace(/\D/g, '').length < 9)
    throw invalid('Enter the mobile money number to pay from');
  return phone;
};
// A price agreed with Relay (priceOverride): plans change through Relay.
const negotiated = (row) => typeof row.get('priceOverride') === 'number';

// Sends the mobile money prompt for a new SubscriptionPayment (`fields`:
// months, kind, plan, discount…). One waiting prompt at a time.
async function collectPayment({ row, platform, user, phone, amount, fields, note }) {
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
    method: 'iotec',
    status: 'pending',
    payer: phone,
    ...fields,
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
      note: `Relay for ${row.get('name')}: ${note}`.slice(0, 100),
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
}

// The plan a period payment buys. While a paid period is running it is the
// renewal plan (moving up goes through startPlanUpgrade, moving down through
// changePlan); otherwise (trial, grace days, closed) any plan on offer.
async function periodPlan(row, platform, key) {
  const { renewalPlanOf, planOfRow } = require('./restaurants');
  const renewal = renewalPlanOf(row, platform);
  if (!key || key === renewal.key) return renewal;
  const target = platform.plans.find((plan) => plan.active && plan.key === key);
  if (!target) throw invalid('Choose one of the plans on offer');
  if (negotiated(row))
    throw invalid('Your price was agreed with Relay. Contact Relay to change plan');
  const access = accessOf(row, platform.graceDays);
  if (access.status === 'active')
    throw invalid(
      target.price > planOfRow(row, platform).price
        ? `To move up to ${target.name} now, use Upgrade: you pay only the difference`
        : `Choose ${target.name} under Plans: it starts when your paid period ends`,
    );
  const problems = await require('./lib/limits').overLimits(target);
  if (problems.length)
    throw invalid(`${target.name} allows less than you have: ${problems.join(', ')}`);
  return target;
}

// Owner: pay a period { months, phone, plan? } with mobile money. ioTec asks
// the phone to approve; checkSubscriptionPayment follows it up.
Parse.Cloud.define('startSubscriptionPayment', async (request) => {
  const { user } = await requireRole(request, ['admin']);
  const p = request.params || {};
  const { values: platform } = await platformSettings();
  if (!iotec.configured()) throw notConfigured(platform);
  const months = Number(p.months);
  if (!MONTHS.includes(months)) throw invalid(`Choose ${MONTHS.join(', ')} months`);
  const phone = cleanPhone(p.phone);
  const row = await restaurantRow();
  const plan = await periodPlan(row, platform, p.plan ? String(p.plan) : '');
  const priced = await offers().priceFor(row, platform, months, undefined, plan);
  const amount = priced.amount;
  if (amount < MIN_AMOUNT) throw invalid('Nothing to pay at this price. Contact Relay');
  return collectPayment({
    row,
    platform,
    user,
    phone,
    amount,
    fields: {
      months,
      kind: 'period',
      plan: plan.key,
      ...(priced.discount
        ? { listAmount: priced.list, discount: priced.discount, discountCode: priced.code }
        : {}),
    },
    note: `${plan.name}, ${months === 12 ? '1 year' : `${months} month${months === 1 ? '' : 's'}`}`,
  });
});

// Moving up while a paid period runs: the bigger plan for the days left, less
// what those days cost on the current plan (at the yearly rate when the
// running period was paid as a year). The days stay; only the difference is
// paid. Null when there is nothing to upgrade this way.
const MONTH_DAYS = 365 / 12;
async function upgradeQuote(row, platform, target) {
  const { planOfRow } = require('./restaurants');
  if (accessOf(row, platform.graceDays).status !== 'active' || negotiated(row)) return null;
  const current = planOfRow(row, platform);
  if (!target || !target.active || !(target.price > current.price)) return null;
  const now = Date.now();
  const until = row.get('paidUntil');
  const days = Math.max(0, (until.getTime() - now) / DAY);
  // The period running now: was it paid as a year?
  const paid = await tenancy.withoutTenant(() =>
    new Parse.Query('SubscriptionPayment')
      .equalTo('tenant', row)
      .equalTo('status', 'paid')
      .greaterThan('periodEnd', new Date(now))
      .find(MASTER),
  );
  const running = paid.find(
    (payment) => payment.get('kind') !== 'upgrade' && payment.get('periodStart')?.getTime() <= now,
  );
  const yearly = Number(running?.get('months')) === 12;
  const rate = (plan) => (yearly ? plan.annualPrice / 12 : plan.price);
  const amount = Math.ceil(((rate(target) - rate(current)) * days) / MONTH_DAYS / 100) * 100;
  return {
    plan: target.key,
    planName: target.name,
    amount: Math.max(0, amount),
    days: Math.ceil(days),
    until: until.toISOString(),
    yearly,
  };
}

// Owner: move up now { plan, phone }: pays the difference for the days left;
// the plan changes once the payment succeeds.
Parse.Cloud.define('startPlanUpgrade', async (request) => {
  const { user } = await requireRole(request, ['admin']);
  const p = request.params || {};
  const { values: platform } = await platformSettings();
  const row = await restaurantRow();
  const target = platform.plans.find((plan) => plan.active && plan.key === p.plan);
  if (!target) throw invalid('Choose one of the plans on offer');
  if (negotiated(row))
    throw invalid('Your price was agreed with Relay. Contact Relay to change plan');
  const quote = await upgradeQuote(row, platform, target);
  if (!quote)
    throw invalid(
      accessOf(row, platform.graceDays).status === 'active'
        ? `${target.name} is not bigger than your plan`
        : `Pay a period on ${target.name} to move to it`,
    );
  // A few days left: too little to collect; the plan changes now.
  if (quote.amount < MIN_AMOUNT) {
    const before = require('./lib/limits').planOf(row);
    row.set('plan', target.key);
    row.unset('nextPlan');
    row.unset('nextPlanFrom');
    await tenancy.withoutTenant(() => row.save(null, MASTER));
    await audit(user, 'subscription.plan_changed', row, { plan: before }, { plan: target.key });
    return { upgraded: true, ...quote };
  }
  if (!iotec.configured()) throw notConfigured(platform);
  const phone = cleanPhone(p.phone);
  return collectPayment({
    row,
    platform,
    user,
    phone,
    amount: quote.amount,
    fields: { months: 0, kind: 'upgrade', plan: target.key },
    note: `upgrade to ${target.name}`,
  });
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
  // Without an amount: the price, after a sign-up code on a first payment.
  const priced =
    p.amount === undefined || p.amount === ''
      ? await offers().priceFor(row, platform, months)
      : null;
  const amount = priced ? priced.amount : Number(p.amount);
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
        ...(priced?.discount
          ? { listAmount: priced.list, discount: priced.discount, discountCode: priced.code }
          : {}),
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
// ended: in the app (once per date; notifications carry a key) and by email
// at each stage of emailStage (once per stage and date).
async function remind(row, platform) {
  const sent = await notifyBilling(row, platform);
  await emailReminder(row, platform);
  return sent?.count ?? 0;
}

// Which billing email is due now, if any:
//   7 and 3 days before the end: billing_due_soon
//   the last day:                billing_due_today
//   after the end (grace days):  billing_overdue, and again on the last day
function emailStage(row, platform, now = Date.now()) {
  const access = accessOf(row, platform.graceDays, now);
  if (!access.until) return null;
  const left = Math.ceil((access.until.getTime() - now) / DAY);
  const day = access.until.toISOString().slice(0, 10);
  const trial = access.status === 'trial';
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (access.status === 'trial' || access.status === 'active') {
    const what = trial ? 'Your free trial ends' : 'Your paid period ends';
    if (left <= 1)
      return {
        kind: 'billing_due_today',
        key: `billing:today:${day}`,
        due: access.until,
        vars: { HEADLINE: `${what} today` },
      };
    if (left <= 7)
      return {
        kind: 'billing_due_soon',
        key: `billing:soon${left <= 3 ? 3 : 7}:${day}`,
        due: access.until,
        vars: { HEADLINE: `${what} in ${plural(left)}`, DAYS_LEFT: String(left) },
      };
    return null;
  }
  if (access.status === 'past_due') {
    const due = new Date(access.until.getTime() - Number(platform.graceDays || 0) * DAY);
    return {
      kind: 'billing_overdue',
      key: `billing:${left <= 1 ? 'closing' : 'overdue'}:${day}`,
      due,
      vars: {
        HEADLINE:
          left <= 1 ? 'Relay closes tomorrow' : `Payment overdue: Relay closes in ${plural(left)}`,
        CLOSES_ON: dateText(access.until),
        DAYS_TO_CLOSE: String(left),
      },
    };
  }
  return null;
}

async function emailReminder(row, platform) {
  if (!row.get('ownerEmail')) return;
  const stage = emailStage(row, platform);
  if (!stage) return;
  const email = require('./lib/email');
  if (!email.ready((await email.loadEmail()).email)) return;
  const once = await tenancy.withoutTenant(() => claimOnce(`email:${row.id}:${stage.key}`));
  if (!once) return;
  const plan = require('./lib/plans').planFor(
    platform.plans || [],
    require('./lib/limits').planOf(row),
  );
  await require('./platformEmail').emailOwner(
    row,
    stage.kind,
    {
      PLAN_NAME: plan.name,
      AMOUNT: moneyText(priceOf(row, platform, renewalPlanOf(row, platform)), platform.currency),
      ANNUAL_AMOUNT: moneyText(annualPriceOf(row, platform), platform.currency),
      DUE_DATE: dateText(stage.due),
      INVOICE_NUMBER: nextInvoiceNumber(row, stage.due),
      ...stage.vars,
    },
    platform,
  );
}

// The receipt by email when a payment is received.
async function emailPaid(row, payment) {
  try {
    if (!row.get('ownerEmail')) return;
    const { values: platform } = await platformSettings();
    const months = Number(payment.get('months')) || 1;
    const plan = require('./lib/plans').planFor(
      platform.plans || [],
      payment.get('plan') || require('./lib/limits').planOf(row),
    );
    const upgrade = payment.get('kind') === 'upgrade';
    const reference = payment.get('reference') || '';
    await require('./platformEmail').emailOwner(
      row,
      'payment_received',
      {
        PLAN_NAME: plan.name,
        AMOUNT: moneyText(payment.get('amount'), payment.get('currency') || platform.currency),
        PERIOD: upgrade
          ? `Upgrade to ${plan.name} for the days left`
          : months === 12
            ? '1 year'
            : `${months} month${months === 1 ? '' : 's'}`,
        PAID_UNTIL: dateText(payment.get('periodEnd')),
        INVOICE_NUMBER: invoiceNumber(row, payment.id),
        REFERENCE: reference || '—',
      },
      platform,
    );
  } catch (error) {
    log('warn', 'email.paid_failed', { restaurant: row.id, message: String(error?.message) });
  }
}

const tell = async (payload) => ({
  count: await notifyAdmins(payload),
  key: payload.key,
  title: payload.title,
  body: payload.body,
});

async function notifyBilling(row, platform) {
  const access = accessOf(row, platform.graceDays);
  const until = access.until;
  if (!until) return 0;
  const left = Math.ceil((until.getTime() - Date.now()) / DAY);
  const price = `${platform.currency} ${priceOf(row, platform, renewalPlanOf(row, platform)).toLocaleString('en-US')}`;
  const day = until.toISOString().slice(0, 10);
  if ((access.status === 'trial' || access.status === 'active') && left <= REMIND_DAYS)
    return tell({
      kind: 'billing.reminder',
      tone: 'warning',
      title:
        access.status === 'trial'
          ? `Your free trial ends in ${left} day${left === 1 ? '' : 's'}`
          : `Your paid month ends in ${left} day${left === 1 ? '' : 's'}`,
      body: `Pay ${price} a month in Admin → Billing to keep the app open.`,
      link: '/admin/site/billing',
      key: `billing:${access.status}:${day}`,
    });
  if (access.status === 'past_due')
    return tell({
      kind: 'billing.reminder',
      tone: 'alert',
      title: `The app closes in ${left} day${left === 1 ? '' : 's'}`,
      body: `Your subscription has ended. Pay ${price} in Admin → Billing to keep the app open.`,
      link: '/admin/site/billing',
      key: `billing:past_due:${day}`,
    });
  return null;
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

module.exports = { billingDue, emailStage };
