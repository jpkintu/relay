// Server-side access control.
//
// 1. Business classes are write-protected: only Cloud Code (master key) may
//    create, update or delete them. Clients read what their ACL allows.
// 2. _User saves from clients cannot touch role, commission, status or code
//    fields, and client sign-up is only open while the database has no users
//    (first owner setup).
// 3. applySecurity() creates the business classes with their fields, applies
//    class-level permissions, re-applies ACLs to existing data and assigns
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
  loadConfig,
  nextStaffCode,
  nextDailyCode,
  isBrokenCode,
} = require('./lib/core');

const PROTECTED_CLASSES = [
  'Order',
  'OrderItem',
  'CashHandover',
  'TillPayout',
  'Shift',
  'AuditLog',
  'Configuration',
  'MenuItem',
  'MenuCategory',
  'Accompaniment',
  'Customer',
  'Counter',
  'DemoOrder',
  'Notification',
  'PushSubscription',
  'Secret',
];
// Classes clients never read directly either.
const PRIVATE_CLASSES = ['Counter', 'DemoOrder', 'Configuration', 'PushSubscription', 'Secret'];
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

// Field definitions for every business class. Creating the classes up front
// (during owner setup) lets clients query them before the first row exists
// and keeps Postgres deployments from failing on unknown columns.
const S = 'String';
const N = 'Number';
const B = 'Boolean';
const D = 'Date';
const user = ['Pointer', '_User'];
const SCHEMAS = {
  Order: {
    orderCode: S,
    channel: S,
    createdBy: user,
    customerName: S,
    customerPhone: S,
    deliveryAddress: S,
    subtotal: N,
    deliveryFee: N,
    total: N,
    paymentMethod: S,
    amountCollected: N,
    paymentCollectedBy: user,
    status: S,
    restaurantStatus: S,
    cashStatus: S,
    commissionAmount: N,
    commissionPaid: B,
    pickedUpAt: D,
    deliveredAt: D,
    settledAt: D,
    customer: ['Pointer', 'Customer'],
    deliveryNotes: S,
    amountToCollect: N,
    shortfallNote: S,
    clientId: S,
    acceptedAt: D,
    readyAt: D,
    cancelledReason: S,
    cancelledBy: user,
    cancelledAt: D,
    disputeFlag: B,
    disputeNote: S,
    disputedBy: user,
    disputedAt: D,
    disputeResolution: S,
    paymentProvider: S,
    paymentReference: S,
    paymentStatus: S,
    paymentCheckedBy: user,
    paymentCheckedAt: D,
    paymentRejectReason: S,
    disputeResolvedBy: user,
    disputeResolvedAt: D,
    cashier: user,
    cashierName: S,
    assignedAt: D,
    cashierRound: N,
    handoverRound: N,
    commissionBase: N,
    deliveryPay: N,
    commissionPayout: ['Pointer', 'TillPayout'],
  },
  OrderItem: {
    order: ['Pointer', 'Order'],
    itemNameSnapshot: S,
    unitPriceSnapshot: N,
    quantity: N,
    lineTotal: N,
    notes: S,
    menuItem: ['Pointer', 'MenuItem'],
    accompanimentIds: 'Array',
    accompanimentNames: 'Array',
  },
  CashHandover: {
    handoverCode: S,
    rider: user,
    cashier: user,
    amount: N,
    countedAmount: N,
    orderCount: N,
    orders: 'Array',
    status: S,
    handedOverAt: D,
    confirmedAt: D,
    disputedAt: D,
    disputeReason: S,
    notes: S,
    resolutionNote: S,
    resolvedBy: user,
    resolvedAt: D,
    requestId: S,
    reviewRound: N,
    tillAt: D,
    returnedOrders: 'Array',
    returnedAmount: N,
    resolution: S,
    shortage: N,
    shortageStatus: S,
    shortagePayout: ['Pointer', 'TillPayout'],
    receivedByOwner: B,
  },
  TillPayout: {
    payoutCode: S,
    kind: S,
    rider: user,
    amount: N,
    earned: N,
    deliveryFees: N,
    deductions: N,
    orders: 'Array',
    shortages: 'Array',
    note: S,
    paidBy: user,
    shift: ['Pointer', 'Shift'],
    paidAt: D,
  },
  Shift: {
    operator: user,
    kind: S,
    status: S,
    openingFloat: N,
    startedAt: D,
    endedAt: D,
    closingFloat: N,
    acknowledgedCash: B,
    expectedTill: N,
    physicalCount: N,
    variance: N,
    varianceNote: S,
    cashIn: N,
    paidOut: N,
  },
  AuditLog: { actor: user, action: S, entityType: S, entityId: S, beforeJson: S, afterJson: S },
  Configuration: {
    restaurantName: S,
    currencySymbol: S,
    currencyCode: S,
    timezone: S,
    defaultDeliveryFee: N,
    maxRiderFloat: N,
    allowBatching: B,
    commissionRounding: S,
    requireCashierConfirmForPickup: B,
    airtelMerchantCode: S,
    airtelMerchantName: S,
    mtnMerchantCode: S,
    mtnMerchantName: S,
    cashReminderHour: N,
    floatWarningPercent: N,
  },
  MenuItem: {
    title: S,
    price: N,
    category: S,
    active: B,
    availableToday: B,
    sortOrder: N,
    accompanimentGroups: 'Array',
  },
  Accompaniment: { title: S, active: B, available: B, sortOrder: N },
  Customer: {
    key: S,
    name: S,
    nameLower: S,
    phone: S,
    addresses: 'Array',
    orderCount: N,
    lastOrderAt: D,
    lastOrder: ['Pointer', 'Order'],
  },
  MenuCategory: { title: S, active: B, sortOrder: N },
  Counter: { key: S, value: N },
  DemoOrder: {
    orderCode: S,
    customerName: S,
    deliveryAddress: S,
    riderName: S,
    itemSummary: S,
    subtotal: N,
    deliveryFee: N,
    total: N,
    status: S,
    restaurantStatus: S,
    isDemo: B,
  },
  PushSubscription: {
    user,
    endpoint: S,
    p256dh: S,
    auth: S,
    userAgent: S,
    lastSeenAt: D,
  },
  Secret: { key: S, value: 'Object' },
  Notification: {
    recipient: user,
    kind: S,
    tone: S,
    title: S,
    body: S,
    link: S,
    order: ['Pointer', 'Order'],
    key: S,
    readAt: D,
  },
};

// PIN re-entry lockout and the rider payout round (see lib/core.js, payouts.js).
const USER_FIELDS = { pinFailures: N, pinLockedUntil: D, payRound: N };

// Creates missing classes with their fields, adds any missing fields to
// existing ones, and (re)applies class-level permissions to all of them.
async function applySchemas() {
  const existing = new Map((await Parse.Schema.all()).map((schema) => [schema.className, schema]));
  const created = [];
  for (const className of PROTECTED_CLASSES) {
    const schema = new Parse.Schema(className);
    const current = existing.get(className);
    const known = current ? Object.keys(current.fields || {}) : [];
    for (const [field, type] of Object.entries(SCHEMAS[className])) {
      if (known.includes(field)) continue;
      if (Array.isArray(type)) schema.addField(field, type[0], { targetClass: type[1] });
      else schema.addField(field, type);
    }
    schema.setCLP(classLevelPermissions(className));
    if (current) await schema.update();
    else {
      await schema.save();
      created.push(className);
    }
  }
  // Fields Cloud Code keeps on team members (Postgres needs the columns).
  const userFields = Object.keys(existing.get('_User')?.fields || {});
  const missing = Object.entries(USER_FIELDS).filter(([field]) => !userFields.includes(field));
  if (missing.length) {
    const schema = new Parse.Schema('_User');
    for (const [field, type] of missing) schema.addField(field, type);
    await schema.update();
  }
  return created;
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
  const updated = { createdClasses: await applySchemas() };
  updated.Order = await eachObject('Order', (o) => saveAcl(o, readAcl(o.get('createdBy'))));
  updated.OrderItem = await eachObject(
    'OrderItem',
    (item) => saveAcl(item, readAcl(item.get('order')?.get('createdBy'))),
    (query) => query.include('order'),
  );
  updated.CashHandover = await eachObject('CashHandover', (h) =>
    saveAcl(h, readAcl(h.get('rider'))),
  );
  // Rider pay became commission + delivery fee: unpaid deliveries recorded
  // before that store the commission only. Add the fee so every report,
  // earnings screen and payout agrees.
  updated.riderPay = await eachObject(
    'Order',
    async (order) => {
      const commission = Number(order.get('commissionAmount') || 0);
      const fee = Number(order.get('deliveryFee') || 0);
      order.set({
        commissionBase: commission,
        deliveryPay: fee,
        commissionAmount: commission + fee,
      });
      await order.save(null, MASTER);
      return true;
    },
    (query) => {
      query.equalTo('status', 'DELIVERED');
      query.doesNotExist('deliveryPay');
      query.notEqualTo('commissionPaid', true);
    },
  );
  updated.TillPayout = await eachObject('TillPayout', (row) =>
    saveAcl(row, readAcl(row.get('rider') || null)),
  );
  updated.Shift = await eachObject('Shift', (s) =>
    saveAcl(s, readAcl(s.get('operator'), ['admin'])),
  );
  for (const className of [
    'MenuItem',
    'MenuCategory',
    'Accompaniment',
    'Customer',
    'Configuration',
    'AuditLog',
  ])
    updated[className] = await eachObject(className, (o) => saveAcl(o, readAcl(null, ['admin'])));
  updated._User = await eachObject(Parse.User, async (user) => {
    const role = await getRoleName(user);
    let changed = false;
    const codeField = role === 'rider' ? 'riderCode' : role === 'cashier' ? 'cashierCode' : null;
    if (codeField && (!user.get(codeField) || isBrokenCode(user.get(codeField)))) {
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
  updated.repairedCodes = await repairCodes();
  return updated;
}

// Gives new codes to orders and handovers saved with a broken code (see
// nextSequence in lib/core.js), numbered on the day they were created.
async function repairCodes() {
  const { values: config } = await loadConfig();
  let repaired = 0;
  for (const [className, field, prefix, digits] of [
    ['Order', 'orderCode', 'ORD', 4],
    ['CashHandover', 'handoverCode', 'HO', 3],
  ]) {
    const broken = [];
    await eachObject(className, async (object) => {
      if (isBrokenCode(object.get(field))) broken.push(object);
      return false;
    });
    broken.sort((a, b) => a.createdAt - b.createdAt);
    for (const object of broken) {
      const before = object.get(field);
      object.set(
        field,
        await nextDailyCode(prefix, digits, config.timezone, {
          className,
          field,
          date: object.createdAt,
        }),
      );
      await object.save(null, MASTER);
      await audit(
        null,
        'code.repaired',
        object,
        { [field]: before },
        { [field]: object.get(field) },
      );
      repaired += 1;
    }
  }
  return repaired;
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
