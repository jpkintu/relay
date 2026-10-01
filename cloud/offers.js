// Relay Hosted: discount codes and referral credit (docs/HOSTED.md → Codes).
//
// A code only counts when a restaurant chooses to pay at sign-up instead of a
// free trial (Restaurant.payFirst): its first payment costs less. A code is
// either one platform staff made (DiscountCode) or another restaurant's own
// code (a referral): the new restaurant gets the platform's referral
// percentage off, and once it has paid, the restaurant that referred it gets
// free months (platform settings: referralPercent, referralMonths).

const { MASTER, invalid, audit, claimOnce, requireRole } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { addMonths } = require('./lib/access');
const { discountFor, describe, cleanCode } = require('./lib/offers');
const { dateText } = require('./lib/emailTemplates');
const { log } = require('./lib/log');
const { platformSettings, requirePlatform, amountFor, codeFrom } = require('./restaurants');

const MONTHS = [1, 3, 6, 12];
const MIN_AMOUNT = 500;

// ---------------------------------------------------------------------------
// Codes

const codeView = (row) => ({
  id: row.id,
  code: row.get('code'),
  kind: row.get('kind'),
  value: row.get('value'),
  minMonths: row.get('minMonths') || 1,
  maxUses: row.get('maxUses') ?? null,
  used: row.get('used') || 0,
  expiresAt: row.get('expiresAt')?.toISOString() || null,
  active: row.get('active') !== false,
  note: row.get('note') || '',
});

// Why a staff code cannot be used now ('' when it can).
function unusable(row, now = Date.now()) {
  if (row.get('active') === false) return 'This code is no longer valid';
  if (row.get('expiresAt') && row.get('expiresAt').getTime() < now) return 'This code has expired';
  const max = row.get('maxUses');
  if (typeof max === 'number' && (row.get('used') || 0) >= max) return 'This code has been used up';
  return '';
}

// The offer a typed code gives, or an error saying why not.
async function resolveCode(raw, platform) {
  const code = cleanCode(raw);
  if (!code) throw invalid('Enter the code');
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('DiscountCode').equalTo('code', code).first(MASTER),
  );
  if (row) {
    const why = unusable(row);
    if (why) throw invalid(why);
    return {
      type: 'code',
      code,
      kind: row.get('kind'),
      value: row.get('value'),
      minMonths: row.get('minMonths') || 1,
    };
  }
  // Another restaurant's code: a referral.
  const percent = Number(platform.referralPercent) || 0;
  const referrer = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').equalTo('code', codeFrom(raw)).first(MASTER),
  );
  if (referrer && referrer.get('suspended') !== true && percent > 0)
    return {
      type: 'referral',
      code: referrer.get('code'),
      kind: 'percent',
      value: percent,
      minMonths: 1,
      referrerId: referrer.id,
      referrerName: referrer.get('name'),
    };
  throw invalid('This code is not valid');
}

// The offer that still applies to a restaurant's first payment, or null.
async function currentOffer(row) {
  if (row.get('payFirst') !== true) return null;
  const offer = row.get('offer');
  if (!offer) return null;
  if (offer.type === 'code') {
    const code = await tenancy.withoutTenant(() =>
      new Parse.Query('DiscountCode').equalTo('code', offer.code).first(MASTER),
    );
    if (!code || unusable(code)) return null;
  }
  return offer;
}

// What `months` cost a restaurant now: { list, discount, amount, code }.
async function priceFor(row, platform, months, offer) {
  const list = amountFor(row, platform, months);
  const using = offer === undefined ? await currentOffer(row) : offer;
  const discount = discountFor(using, list, months, MIN_AMOUNT);
  return { list, discount, amount: list - discount, code: discount ? using.code : '' };
}

// Every period's price, and the offer's wording, for the billing page.
async function pricesFor(row, platform) {
  const offer = await currentOffer(row);
  const prices = {};
  const list = {};
  for (const months of MONTHS) {
    const price = await priceFor(row, platform, months, offer);
    prices[months] = price.amount;
    list[months] = price.list;
  }
  return {
    prices,
    listPrices: list,
    offer: offer
      ? {
          code: offer.code,
          type: offer.type,
          label: describe(offer, platform.currency),
          referrerName: offer.referrerName || '',
        }
      : null,
  };
}

// After the first payment: count the code's use, or credit the restaurant
// that referred this one. Best effort; runs once per restaurant.
async function offerUsed(row, payment, offer) {
  try {
    if (offer.type === 'code' && Number(payment.get('discount')) > 0) {
      const code = await tenancy.withoutTenant(() =>
        new Parse.Query('DiscountCode').equalTo('code', offer.code).first(MASTER),
      );
      if (code) {
        code.increment('used');
        await tenancy.withoutTenant(() => code.save(null, MASTER));
      }
      return;
    }
    if (offer.type !== 'referral') return;
    if (!(await tenancy.withoutTenant(() => claimOnce(`referral:${row.id}`)))) return;
    const { values: platform } = await platformSettings();
    const months = Math.round(Number(platform.referralMonths) || 0);
    if (months <= 0) return;
    const referrer = await tenancy.withoutTenant(() =>
      new Parse.Query('Restaurant').get(offer.referrerId, MASTER).catch(() => null),
    );
    if (!referrer) return;
    const base = new Date(
      Math.max(
        Date.now(),
        referrer.get('trialEndsAt')?.getTime() || 0,
        referrer.get('paidUntil')?.getTime() || 0,
      ),
    );
    const until = addMonths(base, months);
    referrer.set('paidUntil', until);
    await tenancy.withoutTenant(() => referrer.save(null, MASTER));
    tenancy.clearCache();
    const monthsText = `${months} month${months === 1 ? '' : 's'}`;
    await tenancy.runAs(
      referrer.id,
      async () => {
        await require('./notifications').notifyAdmins({
          kind: 'billing.referral',
          tone: 'success',
          title: `${monthsText} free: ${row.get('name')} joined with your code`,
          body: `Thank you for the referral. Relay is now paid until ${dateText(until)}.`,
          link: '/admin/site/billing',
          key: `referral:${row.id}`,
        });
        await audit(null, 'billing.referral_credit', referrer, null, {
          referred: row.get('name'),
          months,
          until: until.toISOString(),
        });
      },
      referrer.get('code'),
    );
    await require('./platformEmail').emailOwner(
      referrer,
      'referral_credit',
      { REFERRED_NAME: row.get('name'), MONTHS_TEXT: monthsText, PAID_UNTIL: dateText(until) },
      platform,
    );
    log('info', 'billing.referral_credit', { restaurant: referrer.id, referred: row.id, months });
  } catch (error) {
    log('warn', 'billing.offer_failed', { restaurant: row.id, message: String(error?.message) });
  }
}

// Public requests are limited per address.
const recent = new Map();
function allow(key) {
  const now = Date.now();
  const times = (recent.get(key) || []).filter((time) => now - time < 3600000);
  if (times.length >= 30) return false;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

// Anyone (the sign-up page): { code, plan } → what the code takes off the
// chosen plan's first payment.
Parse.Cloud.define('checkSignupCode', async (request) => {
  if (!request.master && !allow(request.ip || 'unknown'))
    throw invalid('Too many tries. Try again in an hour');
  const { values: platform } = await platformSettings();
  const offer = await resolveCode(request.params?.code, platform);
  const plans = (platform.plans || []).filter((plan) => plan.active);
  const plan = plans.find((x) => x.key === request.params?.plan) || plans[0];
  const prices = {};
  for (const months of MONTHS) {
    const list = months === 12 ? plan.annualPrice : plan.price * months;
    const discount = discountFor(offer, list, months, MIN_AMOUNT);
    prices[months] = { list, discount, amount: list - discount };
  }
  return {
    code: offer.code,
    type: offer.type,
    label: describe(offer, platform.currency),
    referrerName: offer.referrerName || '',
    currency: platform.currency,
    prices,
  };
});

// Owner of a restaurant that chose to pay first and has not paid yet: start
// the free trial instead (the code no longer applies).
Parse.Cloud.define('startTrialInstead', async (request) => {
  const { user } = await requireRole(request, ['admin']);
  const tenant = tenancy.current();
  const row = await tenancy.withoutTenant(() => new Parse.Query('Restaurant').get(tenant, MASTER));
  if (row.get('payFirst') !== true || row.get('paidUntil'))
    throw invalid('This restaurant is not waiting for its first payment');
  const { values: platform } = await platformSettings();
  const offer = row.get('offer') || null;
  row.set({
    payFirst: false,
    trialEndsAt: new Date(Date.now() + Number(platform.trialDays) * 86400000),
  });
  row.unset('offer');
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  tenancy.clearCache();
  await audit(user, 'billing.trial_instead', row, { offer }, { trialDays: platform.trialDays });
  return { trialEndsAt: row.get('trialEndsAt').toISOString() };
});

// ---------------------------------------------------------------------------
// Platform console → Codes

Parse.Cloud.define('platformListDiscountCodes', async (request) => {
  await requirePlatform(request);
  const query = new Parse.Query('DiscountCode');
  query.descending('createdAt');
  query.limit(500);
  const rows = await tenancy.withoutTenant(() => query.find(MASTER));
  // What each code took off paid first payments. (Filtered here: the
  // discountCode column only exists once a code has been used.)
  const paid = await tenancy.withoutTenant(() =>
    new Parse.Query('SubscriptionPayment')
      .equalTo('status', 'paid')
      .findAll({ ...MASTER, batchSize: 1000 }),
  );
  const signUps = paid.filter((payment) => payment.get('discountCode'));
  const given = {};
  for (const payment of signUps) {
    const code = payment.get('discountCode');
    given[code] = (given[code] || 0) + (Number(payment.get('discount')) || 0);
  }
  return { rows: rows.map((row) => ({ ...codeView(row), given: given[row.get('code')] || 0 })) };
});

// { id?, code, kind: 'percent' | 'amount', value, minMonths?, maxUses?,
//   expiresAt?, active?, note? }
Parse.Cloud.define('platformSaveDiscountCode', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const code = cleanCode(p.code);
  if (code.length < 3 || code.length > 30) throw invalid('Code: 3 to 30 letters or digits');
  const kind = p.kind === 'amount' ? 'amount' : 'percent';
  const value = Number(p.value);
  if (kind === 'percent' && !(Number.isInteger(value) && value >= 1 && value <= 90))
    throw invalid('Percent off: a whole number from 1 to 90');
  if (kind === 'amount' && !(Number.isFinite(value) && value >= 1 && value <= 1e9))
    throw invalid('Amount off: a number above 0');
  const minMonths = Number(p.minMonths || 1);
  if (!MONTHS.includes(minMonths)) throw invalid('Minimum period: 1, 3, 6 or 12 months');
  const maxUses =
    p.maxUses === null || p.maxUses === '' || p.maxUses === undefined ? null : Number(p.maxUses);
  if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses >= 1))
    throw invalid('Uses: a whole number from 1, or empty for no limit');
  const expiresAt = p.expiresAt ? new Date(p.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw invalid('Expiry: a date');
  // A code may not be a restaurant's own code (that is a referral).
  const clash = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').equalTo('code', codeFrom(code)).first(MASTER),
  );
  if (clash) throw invalid(`“${code}” is a restaurant’s code. Choose another`);

  const existing = await tenancy.withoutTenant(() =>
    new Parse.Query('DiscountCode').equalTo('code', code).first(MASTER),
  );
  let row;
  if (p.id) {
    row = await tenancy.withoutTenant(() =>
      new Parse.Query('DiscountCode').get(String(p.id), MASTER).catch(() => null),
    );
    if (!row) throw invalid('Code not found');
    if (existing && existing.id !== row.id) throw invalid(`“${code}” already exists`);
  } else {
    if (existing) throw invalid(`“${code}” already exists`);
    row = new Parse.Object('DiscountCode');
    row.set('used', 0);
    row.setACL(new Parse.ACL());
  }
  const before = row.id ? codeView(row) : null;
  row.set({
    code,
    kind,
    value: kind === 'percent' ? value : Math.round(value),
    minMonths,
    maxUses,
    expiresAt,
    active: p.active !== false,
    note: String(p.note || '')
      .trim()
      .slice(0, 200),
  });
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.discount_code_saved', row, before, codeView(row)),
  );
  return codeView(row);
});

module.exports = { resolveCode, currentOffer, priceFor, pricesFor, offerUsed };
