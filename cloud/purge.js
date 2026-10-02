// Relay Hosted: deleting a restaurant and everything it holds (docs/HOSTED.md).
//
// Two ways:
//   - everything (test restaurants, platform console): every record, the
//     staff accounts and their sessions, the uploaded images, the
//     subscription payments and the restaurant itself. Nothing is left.
//   - keepPayments (a restaurant that stopped paying, automatically or from
//     the console): the same, except its subscription payments, which the
//     platform's accounts need. The restaurant stays as a closed shell that
//     names them (name, plan, Zoho contact); its contact details, sign-in
//     code and everything else go.
//
// Restaurants that stopped paying are warned by email (account_deletion) and
// deleted later (lib/retention.js for when). That runs without a job: at most
// hourly on the back of any owner using the app, whenever platform staff open
// the console, and in the billing job when one is scheduled.

const { MASTER, audit, forbidden, invalid } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { log } = require('./lib/log');
const { deletionOf, deletionStep } = require('./lib/retention');

const errorMessage = (error) => String(error?.message || error);
const tenantPointer = (id) => ({ __type: 'Pointer', className: 'Restaurant', objectId: id });

// Uploaded images on a record (menu photos, the logo), deleted with it.
function filesOf(object) {
  const files = [];
  for (const value of Object.values(object.attributes || {}))
    if (value instanceof Parse.File && value.url()) files.push(value);
  return files;
}
async function destroyFiles(files) {
  let destroyed = 0;
  for (const file of files) {
    try {
      await file.destroy(MASTER);
      destroyed += 1;
    } catch (error) {
      // A file already gone, or a storage that keeps files: not a reason to stop.
      log('warn', 'purge.file_failed', { message: errorMessage(error) });
    }
  }
  return destroyed;
}

// Deletes every row of `query` in batches; returns how many.
async function destroyAllOf(makeQuery, files) {
  let count = 0;
  for (;;) {
    const query = makeQuery();
    query.limit(500);
    const rows = await tenancy.withoutTenant(() => query.find(MASTER));
    if (!rows.length) return count;
    for (const row of rows) files.push(...filesOf(row));
    await tenancy.withoutTenant(() => Parse.Object.destroyAll(rows, MASTER));
    count += rows.length;
  }
}

// Classes deleted first to last (the records before the people who made them).
const ORDER = [
  'OrderItem',
  'Order',
  'DemoOrder',
  'CashHandover',
  'TillPayout',
  'Shift',
  'ZReport',
  'Purchase',
  'Expense',
  'Supplier',
  'Customer',
  'Accompaniment',
  'MenuItem',
  'MenuCategory',
  'Branch',
  'DiningTable',
  'Voucher',
  'Notification',
  'PushSubscription',
  'Counter',
  'ErrorLog',
  'AdminUnlock',
  'Secret',
  'Configuration',
  'AuditLog',
];

// Deletes the restaurant's records. → counts per class.
async function eraseRestaurant(row, { keepPayments }) {
  const id = row.id;
  const counts = {};
  const files = [];
  const scoped = (className) => () => {
    const query = new Parse.Query(className);
    query.equalTo('tenant', tenantPointer(id));
    return query;
  };
  const classes = [...ORDER, ...[...tenancy.SCOPED].filter((c) => !ORDER.includes(c))].filter(
    (c) => c !== '_User' && c !== 'SubscriptionPayment',
  );
  for (const className of classes) {
    const n = await destroyAllOf(scoped(className), files);
    if (n) counts[className] = n;
  }

  // Staff accounts (their sessions first) and the restaurant's roles.
  const staff = () => new Parse.Query(Parse.User).equalTo('tenant', tenantPointer(id));
  const sessions = await destroyAllOf(
    () => new Parse.Query(Parse.Session).matchesQuery('user', staff()),
    files,
  );
  if (sessions) counts.sessions = sessions;
  const users = await destroyAllOf(staff, files);
  if (users) counts.users = users;
  const roles = await destroyAllOf(() => {
    const query = new Parse.Query(Parse.Role);
    query.containedIn(
      'name',
      tenancy.BASE_ROLES.map((base) => tenancy.roleName(base, id)),
    );
    return query;
  }, files);
  if (roles) counts.roles = roles;

  // The platform's "once" markers for this restaurant's emails.
  const markers = await destroyAllOf(() => {
    const query = new Parse.Query('Counter');
    query.doesNotExist('tenant');
    query.startsWith('key', `email:${id}:`);
    return query;
  }, files);
  if (markers) counts.markers = markers;

  if (!keepPayments) {
    const payments = await destroyAllOf(scoped('SubscriptionPayment'), files);
    if (payments) counts.SubscriptionPayment = payments;
  }
  counts.files = await destroyFiles(files);
  return counts;
}

// A code nobody can sign in with, freeing the restaurant's own.
const closedCode = (id) => `deleted-${id.toLowerCase()}-${Date.now().toString(36)}`.slice(0, 30);

async function deleteRestaurant(row, { keepPayments, actor = null, reason, zoho = false }) {
  // A test restaurant also leaves Zoho Books (first: a refusal there stops
  // everything, so it can be tried again).
  const accounting = require('./platformAccounting');
  const inZoho = zoho && !keepPayments ? await accounting.removeRestaurantFromZoho(row.id) : null;
  const before = {
    name: row.get('name'),
    code: row.get('code'),
    ownerName: row.get('ownerName') || '',
    ownerEmail: row.get('ownerEmail') || '',
    plan: row.get('plan') || '',
    paidUntil: row.get('paidUntil') || null,
  };
  // Closed first, so nobody works in it while it is being deleted.
  row.set('suspended', true);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  tenancy.clearCache();
  const counts = await eraseRestaurant(row, { keepPayments });
  if (keepPayments) {
    row.set({
      deleted: true,
      deletedAt: new Date(),
      deletedCode: before.code,
      code: closedCode(row.id),
      ownerEmail: '',
      billingPhone: '',
      note: '',
    });
    for (const field of [
      'resetTokenHash',
      'resetTokenExpires',
      'offer',
      'referralCredit',
      'nextPlan',
      'nextPlanFrom',
      'nextPlanKeep',
      'deletionWarnedAt',
    ])
      row.unset(field);
    await tenancy.withoutTenant(() => row.save(null, MASTER));
  } else {
    await tenancy.withoutTenant(() => row.destroy(MASTER));
  }
  tenancy.clearCache();
  if (inZoho) {
    const journals = await accounting.repostWithout(inZoho.earned, before.name);
    counts.zoho = {
      payments: inZoho.payments,
      invoices: inZoho.invoices,
      contact: inZoho.contact,
      reposted: journals.reposted,
      errors: journals.errors,
    };
  }
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.restaurant_deleted', row, before, { reason, keepPayments, counts }),
  );
  log('info', 'platform.restaurant_deleted', { restaurant: row.id, reason, keepPayments, counts });
  return counts;
}

// ---- Restaurants that stopped paying

async function warn(row, platform) {
  const state = deletionOf(row, platform);
  // The full notice from now on.
  const deleteOn = new Date(
    Math.max(
      state.deleteAt.getTime(),
      Date.now() + Number(platform.deleteWarnDays ?? 3) * 86400000,
    ),
  );
  row.set('deletionWarnedAt', new Date());
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  if (!row.get('ownerEmail')) return false;
  const { dateText, moneyText } = require('./lib/emailTemplates');
  const restaurants = require('./restaurants');
  const plan = restaurants.renewalPlanOf(row, platform);
  return require('./platformEmail').emailOwner(
    row,
    'account_deletion',
    {
      PLAN_NAME: plan.name,
      AMOUNT: moneyText(restaurants.priceOf(row, platform, plan), platform.currency),
      CLOSED_ON: dateText(state.closedAt),
      DELETE_ON: dateText(deleteOn),
    },
    platform,
  );
}

let running = false;
// Warns and deletes as due. → { warned, deleted }
async function retentionSweep() {
  if (running) return { warned: 0, deleted: 0 };
  running = true;
  try {
    const { values: platform } = await require('./restaurants').platformSettings();
    const query = new Parse.Query('Restaurant');
    query.notEqualTo('deleted', true);
    query.notEqualTo('suspended', true);
    const rows = await tenancy.withoutTenant(() => query.findAll({ ...MASTER, batchSize: 500 }));
    let warned = 0;
    let deleted = 0;
    for (const row of rows) {
      try {
        const step = deletionStep(row, platform);
        if (step === 'warn') {
          await warn(row, platform);
          warned += 1;
        } else if (step === 'delete') {
          await deleteRestaurant(row, { keepPayments: true, reason: 'inactive' });
          deleted += 1;
        }
      } catch (error) {
        log('error', 'purge.restaurant_failed', {
          restaurant: row.id,
          message: errorMessage(error),
        });
      }
    }
    return { warned, deleted };
  } finally {
    running = false;
  }
}

// In the background, at most hourly (RELAY_RETENTION_CHECK_MS).
function retentionDue() {
  const ms = Number(process.env.RELAY_RETENTION_CHECK_MS ?? 3600000);
  if (!tenancy.withoutTenant(() => require('./lib/throttle').due('retention', ms))) return;
  void tenancy
    .withoutTenant(() => retentionSweep())
    .catch((error) => log('warn', 'purge.sweep_failed', { message: errorMessage(error) }));
}

// Platform: delete a restaurant. { id, confirm (its code, typed), everything
// (true: a test restaurant, nothing kept; false: keep its subscription
// payments), zoho (with everything: also delete its invoices, payments and
// customer in Zoho Books and re-post the month journals that counted it;
// default true) } → { counts }
Parse.Cloud.define('platformDeleteRestaurant', async (request) => {
  const actor = await require('./restaurants').requirePlatform(request);
  const p = request.params || {};
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(String(p.id || ''), MASTER).catch(() => null),
  );
  if (!row) throw invalid('Restaurant not found');
  const everything = p.everything === true;
  if (row.get('deleted') === true && !everything)
    throw invalid('This restaurant’s data is already deleted');
  const code = row.get('deleted') ? row.get('deletedCode') : row.get('code');
  if (
    String(p.confirm || '')
      .trim()
      .toLowerCase() !== String(code).toLowerCase()
  )
    throw forbidden(`Type the restaurant code (${code}) to confirm`);
  const counts = await deleteRestaurant(row, {
    keepPayments: !everything,
    actor,
    reason: everything ? 'test' : 'platform',
    zoho: everything && p.zoho !== false,
  });
  return { counts, everything };
});

module.exports = { deleteRestaurant, eraseRestaurant, retentionSweep, retentionDue };
