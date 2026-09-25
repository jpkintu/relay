// Server-side access control.
//
// 1. Business classes are write-protected: only Cloud Code (master key) may
//    create, update or delete them. Clients read what their ACL allows.
// 2. _User saves from clients cannot touch role, commission, status or code
//    fields, and client sign-up is only open while the database has no users
//    (first owner setup).
// 3. applySecurity() re-applies CLPs and ACLs to existing data and assigns
//    staff codes. Run it once after deploying (Cloud Job "applySecurity", or
//    Settings → "Apply security rules"); bootstrapOwner also runs it.

const {
  MASTER,
  forbidden,
  countUsers,
  getRoleName,
  readAcl,
  userAcl,
  adminOnly,
  audit,
  nextStaffCode,
} = require('./lib/core');

const PROTECTED_CLASSES = [
  'Order',
  'OrderItem',
  'CashHandover',
  'Shift',
  'AuditLog',
  'Configuration',
  'MenuItem',
  'MenuCategory',
  'Counter',
  'DemoOrder',
];
// Classes clients never read directly either.
const PRIVATE_CLASSES = ['Counter', 'DemoOrder', 'Configuration'];
// Fields a signed-in user may change on their own _User record.
const SELF_EDITABLE_USER_FIELDS = ['password', 'email'];

for (const className of PROTECTED_CLASSES) {
  Parse.Cloud.beforeSave(className, (request) => {
    if (!request.master) throw forbidden('Changes must go through the app');
  });
  Parse.Cloud.beforeDelete(className, (request) => {
    if (!request.master) throw forbidden('Changes must go through the app');
  });
}

Parse.Cloud.beforeSave(Parse.User, async (request) => {
  if (request.master) return;
  if (!request.original) {
    if ((await countUsers()) > 0)
      throw forbidden('Accounts are created by the restaurant administrator');
    // First owner sign-up: never accept privileged fields from the client.
    for (const key of ['active', 'commissionType', 'commissionPerOrder', 'commissionPercent'])
      request.object.unset(key);
    for (const key of ['riderCode', 'cashierCode']) request.object.unset(key);
    return;
  }
  const blocked = request.object
    .dirtyKeys()
    .filter((key) => !SELF_EDITABLE_USER_FIELDS.includes(key));
  if (blocked.length) throw forbidden(`You cannot change ${blocked.join(', ')}`);
});

// A client sign-up gets a private ACL (self + admin) instead of public read.
Parse.Cloud.afterSave(Parse.User, async (request) => {
  if (request.master || request.original) return;
  request.object.setACL(userAcl(request.object, null));
  await request.object.save(null, MASTER);
});

function classLevelPermissions(className) {
  const read = PRIVATE_CLASSES.includes(className) ? {} : { requiresAuthentication: true };
  return {
    get: read,
    find: read,
    count: read,
    create: {},
    update: {},
    delete: {},
    addField: {},
    protectedFields: {},
  };
}

// Only classes that already exist are touched: creating an empty schema here
// would break queries on Postgres. Re-run applySecurity after new classes
// appear; the beforeSave guards above protect them in the meantime.
async function applyClassLevelPermissions() {
  const existing = new Set((await Parse.Schema.all()).map((schema) => schema.className));
  const applied = [];
  for (const className of PROTECTED_CLASSES.filter((name) => existing.has(name))) {
    const schema = new Parse.Schema(className);
    schema.setCLP(classLevelPermissions(className));
    await schema.update();
    applied.push(className);
  }
  return applied;
}

async function eachObject(className, visit, configure) {
  const query = new Parse.Query(className);
  if (configure) configure(query);
  let count = 0;
  await query.each(
    async (object) => {
      if (await visit(object)) count += 1;
    },
    { ...MASTER, batchSize: 200 },
  );
  return count;
}

async function saveAcl(object, acl) {
  if (JSON.stringify(object.getACL()?.toJSON()) === JSON.stringify(acl.toJSON())) return false;
  object.setACL(acl);
  await object.save(null, MASTER);
  return true;
}

async function applySecurity() {
  const updated = { classLevelPermissions: await applyClassLevelPermissions() };
  updated.Order = await eachObject('Order', (o) => saveAcl(o, readAcl(o.get('createdBy'))));
  updated.OrderItem = await eachObject(
    'OrderItem',
    (item) => saveAcl(item, readAcl(item.get('order')?.get('createdBy'))),
    (query) => query.include('order'),
  );
  updated.CashHandover = await eachObject('CashHandover', (h) =>
    saveAcl(h, readAcl(h.get('rider'))),
  );
  updated.Shift = await eachObject('Shift', (s) =>
    saveAcl(s, readAcl(s.get('operator'), ['admin'])),
  );
  for (const className of ['MenuItem', 'MenuCategory', 'Configuration', 'AuditLog'])
    updated[className] = await eachObject(className, (o) => saveAcl(o, readAcl(null, ['admin'])));
  updated._User = await eachObject(Parse.User, async (user) => {
    const role = await getRoleName(user);
    let changed = false;
    const codeField = role === 'rider' ? 'riderCode' : role === 'cashier' ? 'cashierCode' : null;
    if (codeField && !user.get(codeField)) {
      user.set(codeField, await nextStaffCode(role));
      changed = true;
    }
    const acl = userAcl(user, role);
    if (JSON.stringify(user.getACL()?.toJSON()) !== JSON.stringify(acl.toJSON())) {
      user.setACL(acl);
      changed = true;
    }
    if (changed) await user.save(null, MASTER);
    return changed;
  });
  return updated;
}

Parse.Cloud.job('applySecurity', async () => {
  const updated = await applySecurity();
  return `Security applied: ${JSON.stringify(updated)}`;
});

Parse.Cloud.define('adminApplySecurity', async (request) => {
  const actor = await adminOnly(request);
  const updated = await applySecurity();
  await audit(actor, 'security.applied', { className: 'Security', id: 'all' }, null, updated);
  return updated;
});

module.exports = { applySecurity };
