// Relay Hosted: restaurants, self sign-up with a free trial, platform settings
// and the platform role (docs/HOSTED.md).

const {
  MASTER,
  audit,
  claimOnce,
  endSessions,
  forbidden,
  invalid,
  readAcl,
  requireUser,
  userAcl,
} = require('./lib/core');
const tenancy = require('./lib/tenant');
const { accessOf } = require('./lib/access');
const { log } = require('./lib/log');

const DEFAULT_PLATFORM = {
  // Monthly prices per plan (owner's decision 2026-09-30): Basic (1 branch,
  // 2 cashiers, 5 riders, no finance or reporting) and Enterprise (all).
  // `monthlyPrice` is the Basic price (the flat price before plans).
  monthlyPrice: 100000,
  enterprisePrice: 200000,
  currency: 'UGX',
  trialDays: 14,
  graceDays: 7,
  // Shown to restaurants that need to renew or are suspended.
  supportContact: '',
};

// Platform-wide settings (the platform console changes them).
async function platformSettings() {
  const row = await tenancy.withoutTenant(() => new Parse.Query('PlatformSettings').first(MASTER));
  const values = { ...DEFAULT_PLATFORM };
  for (const key of Object.keys(DEFAULT_PLATFORM)) {
    const value = row?.get(key);
    if (value !== undefined && value !== null && value !== '') values[key] = value;
  }
  // The plans (lib/plans.js), for prices and limits.
  values.plans = await require('./lib/plans').loadPlans(values);
  return { row, values };
}

// The same, cached briefly for the per-request access check.
let cachedSettings = null;
async function cachedPlatform() {
  if (cachedSettings && Date.now() - cachedSettings.at < 30000) return cachedSettings.values;
  const { values } = await platformSettings();
  cachedSettings = { values, at: Date.now() };
  return values;
}

// What a restaurant pays each month: its own (negotiated) price when you set
// one, else its plan's price.
const planOfRow = (row, platform) =>
  require('./lib/plans').planFor(platform.plans || [], row.get('plan') || '');
const priceOf = (row, platform) => {
  const own = row.get('priceOverride');
  if (typeof own === 'number' && own >= 0) return own;
  return planOfRow(row, platform).price;
};

// Functions an expired or suspended restaurant can still use: sign-in
// details, the profile (which says why the app is closed), changing one's
// own PIN, signing out, crash reports and (phase 3) paying.
const OPEN_WHEN_CLOSED = new Set([
  'getAppInfo',
  'getMyProfile',
  'changeMyPin',
  'removePushSubscription',
  'reportClientError',
  // Paying the subscription (billing.js).
  'getBilling',
  'startSubscriptionPayment',
  'checkSubscriptionPayment',
  // Choosing a plan (restaurants.js, billing.js).
  'getPlans',
  'changePlan',
]);

// Called for every Cloud function run for a restaurant (errors.js). Access
// is worked out from the dates each time (lib/access.js).
async function checkAccess(name, restaurant) {
  if (OPEN_WHEN_CLOSED.has(name)) return;
  const platform = await cachedPlatform();
  const access = accessOf({ get: (key) => restaurant[key] }, platform.graceDays);
  if (access.ok) return;
  const contact = platform.supportContact ? ` (${platform.supportContact})` : '';
  throw forbidden(
    access.status === 'suspended'
      ? `This restaurant is suspended. Contact Relay${contact}`
      : 'This restaurant’s subscription has ended. The owner can renew it in the app',
  );
}

// Suspended restaurants cannot sign in at all; expired ones can, so the
// owner can renew.
Parse.Cloud.beforeLogin(async (request) => {
  const tenant = request.object.get('tenant');
  if (!tenant) return;
  const restaurant = await tenancy.lookUp('objectId', tenant.id);
  if (restaurant?.suspended) {
    const { supportContact } = await cachedPlatform();
    throw forbidden(
      `This restaurant is suspended. Contact Relay${supportContact ? ` (${supportContact})` : ''}`,
    );
  }
});

// Codes appear in the restaurant's web address and usernames: lower-case
// letters, digits and dashes.
const codeFrom = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
const RESERVED = new Set(['admin', 'api', 'app', 'platform', 'relay', 'signup', 'www', 'help']);

async function codeTaken(code) {
  if (RESERVED.has(code)) return true;
  const query = new Parse.Query('Restaurant');
  query.equalTo('code', code);
  return !!(await tenancy.withoutTenant(() => query.first(MASTER)));
}

// Sign-ups are limited per address so the page cannot be used to flood the
// platform with restaurants.
const recent = new Map();
function allowSignUp(key) {
  const now = Date.now();
  const times = (recent.get(key) || []).filter((time) => now - time < 3600000);
  if (times.length >= 5) return false;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

// Anyone: is this restaurant code free? { code } → { code, free }.
Parse.Cloud.define('checkRestaurantCode', async (request) => {
  const code = codeFrom(request.params?.code);
  if (code.length < 3) return { code, free: false };
  return { code, free: !(await codeTaken(code)) };
});

// Anyone: start a restaurant on a free trial. { restaurantName, code?,
// ownerName, username, pin, phone } → { code, username } to sign in with.
Parse.Cloud.define('signUpRestaurant', async (request) => {
  const p = request.params || {};
  const restaurantName = String(p.restaurantName || '')
    .trim()
    .slice(0, 80);
  const code = codeFrom(p.code || restaurantName);
  const ownerName = String(p.ownerName || '')
    .trim()
    .slice(0, 80);
  const username = String(p.username || '')
    .trim()
    .toLowerCase();
  const pin = String(p.pin || '');
  const phone = String(p.phone || '')
    .replace(/[^\d+]/g, '')
    .slice(0, 20);
  // Password resets and everything Relay emails go here.
  const ownerEmail = String(p.email || '')
    .trim()
    .toLowerCase();
  if (restaurantName.length < 2) throw invalid('Enter the restaurant’s name');
  if (code.length < 3) throw invalid('The restaurant code needs at least 3 letters or digits');
  if (!ownerName) throw invalid('Enter your name');
  if (!/^[-a-z0-9_.]{3,32}$/.test(username))
    throw invalid('Username: 3 to 32 letters, digits, dots, dashes or underscores');
  if (pin.length < 6) throw invalid('Choose a PIN or password of at least 6 characters');
  if (phone.replace(/\D/g, '').length < 9) throw invalid('Enter your phone number');
  if (!require('./lib/email').validEmail(ownerEmail)) throw invalid('Enter your email address');
  // Only complete sign-ups count towards the limit.
  if (!request.master && !allowSignUp(request.ip || 'unknown'))
    throw forbidden('Too many sign-ups from here. Try again in an hour');
  if (
    (await codeTaken(code)) ||
    !(await tenancy.withoutTenant(() => claimOnce(`restaurant:${code}`)))
  )
    throw invalid(`The code “${code}” is taken. Choose another`);

  const { values: platform } = await platformSettings();
  const restaurant = new Parse.Object('Restaurant');
  restaurant.set({
    name: restaurantName,
    code,
    suspended: false,
    trialEndsAt: new Date(Date.now() + Number(platform.trialDays) * 86400000),
    ownerName,
    ownerEmail,
    billingPhone: phone,
    priceOverride: null,
    // The plan chosen at sign-up (one offered), else the first offered.
    plan: (
      platform.plans.find((x) => x.active && x.key === p.plan) ||
      platform.plans.find((x) => x.active) || { key: '' }
    ).key,
  });
  restaurant.setACL(new Parse.ACL());
  await tenancy.withoutTenant(() => restaurant.save(null, MASTER));
  tenancy.clearCache();

  await tenancy.runAs(
    restaurant.id,
    async () => {
      const owner = new Parse.User();
      owner.set({
        username: tenancy.fullUsername(username),
        password: pin,
        name: ownerName,
        phone,
        active: true,
      });
      await owner.signUp(null, MASTER);
      owner.setACL(userAcl(owner, 'admin'));
      await owner.save(null, MASTER);
      const config = new Parse.Object('Configuration');
      config.set({ restaurantName });
      config.setACL(readAcl(null, ['admin']));
      await config.save(null, MASTER);
      await require('./admin').makeOwner(owner, owner);
      await audit(owner, 'restaurant.signed_up', restaurant, null, {
        name: restaurantName,
        code,
        trialDays: platform.trialDays,
      });
    },
    code,
  );
  log('info', 'restaurant.signed_up', { restaurant: restaurant.id, code });
  // Welcome email (best effort; nothing waits for it).
  const { appUrl } = (await require('./lib/email').loadEmail()).email;
  void require('./platformEmail').emailOwner(
    restaurant,
    `Welcome to Relay, ${restaurantName}`,
    [
      `Hello ${ownerName},`,
      '',
      `${restaurantName} is set up on Relay with a ${platform.trialDays}-day free trial.`,
      `Restaurant code: ${code}`,
      `Your username: ${username}`,
      appUrl ? `Sign in: ${appUrl}` : '',
      '',
      'Forgot your password? Use "Forgot password" on the sign-in page and we will email you a link.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  );
  return { code, username: tenancy.fullUsername(username, code) };
});

// The signed-in person's restaurant, for the app's header and billing notices.
async function restaurantSummary() {
  const tenant = tenancy.current();
  if (!tenant) return null;
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(tenant, MASTER).catch(() => null),
  );
  if (!row) return null;
  const { values: platform } = await platformSettings();
  return summarise(row, platform);
}

function summarise(row, platform) {
  const access = accessOf(row, platform.graceDays);
  return {
    id: row.id,
    code: row.get('code'),
    name: row.get('name'),
    status: access.status,
    usable: access.ok,
    // When the trial, the paid month or the grace days end.
    until: access.until?.toISOString() || null,
    trialEndsAt: row.get('trialEndsAt')?.toISOString() || null,
    paidUntil: row.get('paidUntil')?.toISOString() || null,
    monthlyPrice: priceOf(row, platform),
    plan: planOfRow(row, platform).key,
    planName: planOfRow(row, platform).name,
    currency: platform.currency,
    graceDays: Number(platform.graceDays) || 0,
    supportContact: platform.supportContact || '',
    ownerEmail: row.get('ownerEmail') || '',
  };
}

// Platform staff: people with the "platform" role, who belong to no
// restaurant. Checked explicitly, never through a restaurant role.
async function isPlatform(user) {
  if (!user || user.get('tenant')) return false;
  const query = new Parse.Query(Parse.Role);
  query.equalTo('name', 'platform');
  query.equalTo('users', user);
  return !!(await tenancy.withoutTenant(() => query.first(MASTER)));
}

async function requirePlatform(request) {
  const user = requireUser(request);
  if (!(await isPlatform(user))) throw forbidden('platform role required');
  return user;
}

// Master key only (Back4App dashboard → Cloud Code → Jobs, or the REST
// console): create or reset a platform account. { username, password, name }.
async function createPlatformAdmin(params) {
  const username = String(params.username || '')
    .trim()
    .toLowerCase();
  const password = String(params.password || '');
  if (!/^[-a-z0-9_.]{3,32}$/.test(username) || password.length < 10)
    throw invalid('Give a username and a password of at least 10 characters');
  return tenancy.withoutTenant(async () => {
    const query = new Parse.Query(Parse.User);
    query.equalTo('username', username);
    let user = await query.first(MASTER);
    if (user && user.get('tenant')) throw invalid('That username belongs to a restaurant');
    if (!user) {
      user = new Parse.User();
      user.set({ username, password, name: String(params.name || username), active: true });
      await user.signUp(null, MASTER);
    } else {
      user.set({ password, active: true });
      await user.save(null, MASTER);
    }
    const acl = new Parse.ACL();
    acl.setReadAccess(user, true);
    acl.setWriteAccess(user, true);
    user.setACL(acl);
    await user.save(null, MASTER);
    let role = await new Parse.Query(Parse.Role).equalTo('name', 'platform').first(MASTER);
    if (!role) {
      role = new Parse.Role('platform', new Parse.ACL());
      await role.save(null, MASTER);
    }
    role.getUsers().add(user);
    await role.save(null, MASTER);
    return { username, role: 'platform' };
  });
}

Parse.Cloud.define('createPlatformAdmin', async (request) => {
  if (!request.master) throw forbidden('Master key required');
  return createPlatformAdmin(request.params || {});
});
// Back4App's Jobs page only has "Run now", which sends no parameters, so the
// job also reads the account from the app's environment variables:
// RELAY_PLATFORM_USERNAME, RELAY_PLATFORM_PASSWORD, RELAY_PLATFORM_NAME.
// Remove the password variable once the account works.
function platformAdminFromEnv() {
  const env = (name) => String(process.env[name] || '').trim();
  return {
    username: env('RELAY_PLATFORM_USERNAME'),
    password: env('RELAY_PLATFORM_PASSWORD'),
    name: env('RELAY_PLATFORM_NAME'),
  };
}

Parse.Cloud.job('createPlatformAdmin', async (request) => {
  const given = request.params || {};
  const params = given.username || given.password ? given : platformAdminFromEnv();
  if (!params.username || !params.password)
    throw invalid(
      'Set RELAY_PLATFORM_USERNAME and RELAY_PLATFORM_PASSWORD (10+ characters) in App Settings → Environment Variables, then Run now again',
    );
  const result = await createPlatformAdmin(params);
  return `Platform account ready: ${result.username}`;
});

// Runs `work` once for each restaurant that is not suspended (jobs). Expired
// ones still run: their records stay tidy until they pay again.
async function forEachRestaurant(work) {
  const query = new Parse.Query('Restaurant');
  query.notEqualTo('suspended', true);
  const rows = await tenancy.withoutTenant(() => query.findAll({ ...MASTER, batchSize: 500 }));
  const results = [];
  for (const row of rows) {
    try {
      results.push(await tenancy.runAs(row.id, () => work(row), row.get('code')));
    } catch (error) {
      log('error', 'restaurant.job_failed', {
        restaurant: row.id,
        message: String(error?.message),
      });
    }
  }
  return results;
}

// ---- Platform console (docs/HOSTED.md). Platform staff see every
// restaurant's name, contact, subscription and size, never its orders or
// customers.

const DAY = 86400000;
const pointerTo = (row) => ({ __type: 'Pointer', className: 'Restaurant', objectId: row.id });

async function restaurantRow(row, platform) {
  const since = new Date(Date.now() - 30 * DAY);
  const staff = new Parse.Query(Parse.User);
  staff.equalTo('tenant', pointerTo(row));
  staff.notEqualTo('active', false);
  const orders = new Parse.Query('Order');
  orders.equalTo('tenant', pointerTo(row));
  orders.greaterThanOrEqualTo('createdAt', since);
  const [staffCount, orders30] = await Promise.all([staff.count(MASTER), orders.count(MASTER)]);
  return {
    ...summarise(row, platform),
    ownerName: row.get('ownerName') || '',
    billingPhone: row.get('billingPhone') || '',
    ownerEmail: row.get('ownerEmail') || '',
    priceOverride: typeof row.get('priceOverride') === 'number' ? row.get('priceOverride') : null,
    suspended: row.get('suspended') === true,
    note: row.get('note') || '',
    createdAt: row.createdAt.toISOString(),
    staff: staffCount,
    orders30,
  };
}

// Platform: every restaurant with its subscription and size. → { settings, rows }
Parse.Cloud.define('platformListRestaurants', async (request) => {
  await requirePlatform(request);
  const { values: platform } = await platformSettings();
  const query = new Parse.Query('Restaurant');
  const rows = await tenancy.withoutTenant(() => query.findAll({ ...MASTER, batchSize: 500 }));
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return {
    settings: platform,
    rows: await Promise.all(rows.map((row) => restaurantRow(row, platform))),
  };
});

const dateOrNull = (value, label) => {
  if (value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw invalid(`${label}: not a date`);
  return date;
};

// Platform: change one restaurant's price, trial, paid-until date,
// suspension or note. Only the fields given change. { id, priceOverride?
// (number, or null for the platform price), trialEndsAt?, paidUntil?,
// suspended?, note? }
Parse.Cloud.define('platformUpdateRestaurant', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(String(p.id || ''), MASTER).catch(() => null),
  );
  if (!row) throw invalid('Restaurant not found');
  const fields = [
    'plan',
    'priceOverride',
    'trialEndsAt',
    'paidUntil',
    'suspended',
    'note',
    'ownerEmail',
  ];
  const before = Object.fromEntries(fields.map((field) => [field, row.get(field) ?? null]));
  // The platform may put a restaurant on any plan (over the limits too: what
  // it has is kept, only additions are checked).
  if ('plan' in p) {
    const { values: platform } = await platformSettings();
    if (!platform.plans.some((x) => x.key === p.plan)) throw invalid('Unknown plan');
    row.set('plan', p.plan);
  }
  if ('priceOverride' in p) {
    if (p.priceOverride === null || p.priceOverride === '') row.unset('priceOverride');
    else {
      const price = Number(p.priceOverride);
      if (!Number.isFinite(price) || price < 0 || price > 100000000)
        throw invalid('Price: a number from 0 up');
      row.set('priceOverride', Math.round(price));
    }
  }
  if ('trialEndsAt' in p) row.set('trialEndsAt', dateOrNull(p.trialEndsAt, 'Trial end'));
  if ('paidUntil' in p) {
    const paid = dateOrNull(p.paidUntil, 'Paid until');
    if (paid) row.set('paidUntil', paid);
    else row.unset('paidUntil');
  }
  if ('suspended' in p) row.set('suspended', p.suspended === true);
  if ('ownerEmail' in p) {
    const email = String(p.ownerEmail || '')
      .trim()
      .toLowerCase();
    if (email && !require('./lib/email').validEmail(email))
      throw invalid('The owner email is not an email address');
    row.set('ownerEmail', email);
  }
  if ('note' in p)
    row.set(
      'note',
      String(p.note || '')
        .trim()
        .slice(0, 500),
    );
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  tenancy.clearCache();
  const after = Object.fromEntries(fields.map((field) => [field, row.get(field) ?? null]));
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.restaurant_updated', row, before, after),
  );
  const { values: platform } = await platformSettings();
  return restaurantRow(row, platform);
});

// A password to read out over the phone: no look-alike letters or digits.
function readablePassword(length = 10) {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(length);
  return Array.from(bytes, (byte) => letters[byte % letters.length]).join('');
}

// Platform: an owner who cannot sign in calls you. Gives the restaurant's
// owner account (or the admin named { username }) a new temporary password,
// signs it out everywhere and shows the password once. { id, username? }
// → { username, password }
Parse.Cloud.define('platformResetOwner', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const row = await tenancy
    .withoutTenant(() => new Parse.Query('Restaurant').get(String(p.id || ''), MASTER))
    .catch(() => null);
  if (!row) throw invalid('Restaurant not found');
  const result = await tenancy.runAs(
    row.id,
    async () => {
      const role = await new Parse.Query(Parse.Role).equalTo('name', 'admin').first(MASTER);
      if (!role) throw invalid('This restaurant has no owner account');
      const owners = await role.getUsers().query().ascending('createdAt').find(MASTER);
      const wanted = String(p.username || '')
        .trim()
        .toLowerCase();
      const owner = wanted ? owners.find((u) => u.getUsername() === wanted) : owners[0];
      if (!owner) throw invalid(`No owner called “${wanted}” here`);
      const password = readablePassword();
      owner.set({ password, active: true });
      await owner.save(null, MASTER);
      await endSessions(owner);
      return { owner, password };
    },
    row.get('code'),
  );
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.owner_reset', row, null, { username: result.owner.getUsername() }),
  );
  log('info', 'platform.owner_reset', { restaurant: row.id });
  return { username: result.owner.getUsername(), password: result.password };
});

// Platform: the currency, trial and grace days and the support contact
// restaurants see (prices are on the plans).
Parse.Cloud.define('platformSaveSettings', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const trialDays = Number(p.trialDays);
  const graceDays = Number(p.graceDays);
  const currency = String(p.currency || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid('Currency: a 3-letter code such as UGX');
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365)
    throw invalid('Trial days: 0 to 365');
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60)
    throw invalid('Grace days: 0 to 60');
  const { row: existing, values: before } = await platformSettings();
  const row = existing || new Parse.Object('PlatformSettings');
  if (!existing) row.setACL(new Parse.ACL());
  // Prices belong to the plans (platformSavePlan).
  row.set({
    currency,
    trialDays,
    graceDays,
    supportContact: String(p.supportContact || '')
      .trim()
      .slice(0, 120),
  });
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  cachedSettings = null;
  const { values } = await platformSettings();
  await tenancy.withoutTenant(() => audit(actor, 'platform.settings_saved', row, before, values));
  return values;
});

// ---------------------------------------------------------------------------
// Plans (lib/plans.js)

// Anyone (the sign-up form) and owners (Subscription → Plans): the plans on
// offer, with their prices, limits and parts of the app.
Parse.Cloud.define('getPlans', async () => {
  const { values: platform } = await platformSettings();
  return {
    currency: platform.currency,
    plans: platform.plans
      .filter((plan) => plan.active)
      .map(({ key, name, description, price, limits, features }) => ({
        key,
        name,
        description,
        price,
        limits,
        features,
      })),
  };
});

// Platform: every plan with how many restaurants are on it.
Parse.Cloud.define('platformListPlans', async (request) => {
  await requirePlatform(request);
  const { values: platform } = await platformSettings();
  const restaurants = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').select('plan').findAll({ ...MASTER, batchSize: 500 }),
  );
  const planFor = require('./lib/plans').planFor;
  const counts = {};
  for (const row of restaurants) {
    const key = planFor(platform.plans, row.get('plan') || '').key;
    counts[key] = (counts[key] || 0) + 1;
  }
  const { FEATURES, LIMITS } = require('./lib/plans');
  return {
    currency: platform.currency,
    features: FEATURES,
    limits: LIMITS,
    plans: platform.plans.map((plan) => ({ ...plan, restaurants: counts[plan.key] || 0 })),
  };
});

// Platform: add or change a plan. { id?, name, description, price,
// limits: { branches, cashier, rider, finance } (null = no limit),
// features: { branches, finance, … }, active, sortOrder? }. A plan is never
// deleted; one taken off offer keeps its restaurants.
Parse.Cloud.define('platformSavePlan', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const plans = require('./lib/plans');
  const name = String(p.name || '')
    .trim()
    .slice(0, 40);
  if (name.length < 2) throw invalid('Give the plan a name');
  const price = Number(p.price);
  if (!Number.isFinite(price) || price < 0 || price > 100000000)
    throw invalid('Price: a number from 0 up');
  const limits = {};
  for (const key of plans.LIMITS) {
    const value = p.limits?.[key];
    if (value === null || value === undefined || value === '') limits[key] = null;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10000)
        throw invalid(`${key} limit: a whole number from 0, or empty for no limit`);
      limits[key] = n;
    }
  }
  if (limits.branches === 0) throw invalid('A plan needs at least 1 branch');
  const features = Object.fromEntries(
    plans.FEATURES.map((key) => [key, p.features?.[key] === true]),
  );
  const rows = await tenancy.withoutTenant(() => new Parse.Query('Plan').limit(200).find(MASTER));
  if (rows.some((row) => row.id !== p.id && row.get('name').toLowerCase() === name.toLowerCase()))
    throw invalid(`There is already a plan called "${name}"`);
  let row = p.id ? rows.find((r) => r.id === p.id) : null;
  if (p.id && !row) throw invalid('Unknown plan');
  const before = row ? plans.view(row) : null;
  if (!row) {
    row = new Parse.Object('Plan');
    let key =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'plan';
    while (rows.some((r) => r.get('key') === key)) key = `${key}-2`;
    row.set({ key, sortOrder: rows.length });
    row.setACL(new Parse.ACL());
  }
  const active = p.active === undefined ? row.get('active') !== false : p.active === true;
  if (!active && !rows.some((r) => r.id !== row.id && r.get('active') !== false))
    throw invalid('Keep at least one plan on offer');
  row.set({
    name,
    description: String(p.description || '')
      .trim()
      .slice(0, 160),
    price: Math.round(price),
    limits,
    features,
    active,
    ...(p.sortOrder !== undefined && { sortOrder: Math.round(Number(p.sortOrder) || 0) }),
  });
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  plans.clearPlans();
  cachedSettings = null;
  await tenancy.withoutTenant(() =>
    audit(
      actor,
      before ? 'platform.plan_updated' : 'platform.plan_created',
      row,
      before,
      plans.view(row),
    ),
  );
  return plans.view(row);
});

// Platform: recent changes made in the console. → { rows }
Parse.Cloud.define('platformGetAudit', async (request) => {
  await requirePlatform(request);
  const query = new Parse.Query('AuditLog');
  query.startsWith('action', 'platform.');
  query.doesNotExist('tenant');
  query.descending('createdAt');
  query.limit(100);
  query.include('actor');
  const rows = await tenancy.withoutTenant(() => query.find(MASTER));
  return {
    rows: rows.map((row) => ({
      at: row.createdAt.toISOString(),
      action: row.get('action'),
      by: row.get('actor')?.get('name') || row.get('actor')?.getUsername() || '',
      entityId: row.get('entityId'),
      before: JSON.parse(row.get('beforeJson') || '{}'),
      after: JSON.parse(row.get('afterJson') || '{}'),
    })),
  };
});

module.exports = {
  priceOf,
  checkAccess,
  isPlatform,
  accessOf,
  platformSettings,
  restaurantSummary,
  requirePlatform,
  forEachRestaurant,
  codeFrom,
};
