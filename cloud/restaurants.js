// Relay Hosted: restaurants, self sign-up with a free trial, platform settings
// and the platform role (docs/HOSTED.md).

const {
  MASTER,
  audit,
  claimOnce,
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
  monthlyPrice: 50000,
  currency: 'UGX',
  trialDays: 14,
  graceDays: 7,
};

// Platform-wide settings (the platform console changes them).
async function platformSettings() {
  const row = await tenancy.withoutTenant(() => new Parse.Query('PlatformSettings').first(MASTER));
  const values = { ...DEFAULT_PLATFORM };
  for (const key of Object.keys(DEFAULT_PLATFORM)) {
    const value = row?.get(key);
    if (value !== undefined && value !== null && value !== '') values[key] = value;
  }
  return { row, values };
}

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
  if (restaurantName.length < 2) throw invalid('Enter the restaurant’s name');
  if (code.length < 3) throw invalid('The restaurant code needs at least 3 letters or digits');
  if (!ownerName) throw invalid('Enter your name');
  if (!/^[-a-z0-9_.]{3,32}$/.test(username))
    throw invalid('Username: 3 to 32 letters, digits, dots, dashes or underscores');
  if (pin.length < 6) throw invalid('Choose a PIN or password of at least 6 characters');
  if (phone.replace(/\D/g, '').length < 9) throw invalid('Enter your phone number');
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
    billingPhone: phone,
    priceOverride: null,
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
  };
}

// Platform staff: people with the "platform" role (not tied to a restaurant).
async function requirePlatform(request) {
  const user = requireUser(request);
  if (user.get('tenant')) throw forbidden('platform role required');
  const query = new Parse.Query(Parse.Role);
  query.equalTo('name', 'platform');
  query.equalTo('users', user);
  if (!(await tenancy.withoutTenant(() => query.first(MASTER))))
    throw forbidden('platform role required');
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
Parse.Cloud.job('createPlatformAdmin', async (request) => {
  const result = await createPlatformAdmin(request.params || {});
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

module.exports = {
  accessOf,
  platformSettings,
  restaurantSummary,
  requirePlatform,
  forEachRestaurant,
  codeFrom,
};
