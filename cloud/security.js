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
  invalid,
  getRoleName,
  readAcl,
  userAcl,
  audit,
  loadConfig,
  nextStaffCode,
  nextDailyCode,
  isBrokenCode,
} = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');

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
  'ZReport',
  'ErrorLog',
  'AdminUnlock',
  'Branch',
  'Supplier',
  'Purchase',
  'Expense',
  // Relay Hosted.
  'Restaurant',
  'PlatformSettings',
  'SubscriptionPayment',
  'Plan',
  'PlatformBroadcast',
  'DiscountCode',
  'AccountingPosting',
];
// Classes clients never read directly either.
const PRIVATE_CLASSES = [
  'Counter',
  'DemoOrder',
  'Configuration',
  'PushSubscription',
  'Secret',
  'ZReport',
  'ErrorLog',
  'AdminUnlock',
  'Restaurant',
  'PlatformSettings',
  'SubscriptionPayment',
  'Plan',
  'PlatformBroadcast',
  'DiscountCode',
  'AccountingPosting',
];
// Fields a signed-in user may change on their own _User record. The PIN
// (password) is changed through changeMyPin, which checks the old one.
const SELF_EDITABLE_USER_FIELDS = ['email'];

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
  // Relay Hosted: accounts come from the restaurant sign-up page or the
  // restaurant's administrator, never from a client sign-up.
  if (!request.original) throw forbidden('Accounts are created by the restaurant administrator');
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
const branch = ['Pointer', 'Branch'];
const SCHEMAS = {
  // Outlets of the restaurant (branches.js).
  Branch: { name: S, address: S, phone: S, active: B, main: B, sortOrder: N },
  Order: {
    branch,
    // Split orders: the splits in the order entered (lines carry `split`).
    splits: 'Array',
    // Tax (EFRIS): the fiscal document for the sale (cloud/efris.js).
    efrisStatus: S,
    efrisFdn: S,
    efrisVerification: S,
    efrisInvoiceId: S,
    efrisQr: S,
    efrisIssuedAt: D,
    efrisError: S,
    efrisAttempts: N,
    efrisAttemptAt: D,
    orderCode: S,
    // Longest prep time of its dishes when placed (minutes; 0 = not set).
    prepMinutes: N,
    channel: S,
    createdBy: user,
    customerName: S,
    customerPhone: S,
    location: 'GeoPoint',
    orderType: S,
    source: S,
    placedBy: user,
    tableLabel: S,
    billOpen: B,
    tillCashier: user,
    tillShift: ['Pointer', 'Shift'],
    paidAt: D,
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
    paidAtDoor: B,
    deliveryFeePaid: B,
    feePayout: ['Pointer', 'TillPayout'],
    // Customer details removed (privacy retention or a request).
    anonymisedAt: D,
    // Automatic mobile money: the request sent to the customer's phone.
    payRequestStatus: S,
    payRequestId: S,
    payRequestPhone: S,
    payRequestAt: D,
    payRequestSentAt: D,
    payRequestError: S,
    paymentAuto: B,
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
    // Charged sides: price of each chosen accompaniment (0 = free) and their
    // sum per unit; lineTotal = (unitPriceSnapshot + extrasPerUnit) × quantity.
    accompanimentPrices: 'Array',
    extrasPerUnit: N,
    // Split orders: the split (guest or portion) this line belongs to.
    split: S,
  },
  CashHandover: {
    branch,
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
    branch,
    payoutCode: S,
    kind: S,
    rider: user,
    amount: N,
    earned: N,
    deliveryFees: N,
    feesOnly: B,
    deductions: N,
    orders: 'Array',
    shortages: 'Array',
    note: S,
    paidBy: user,
    shift: ['Pointer', 'Shift'],
    paidAt: D,
  },
  Shift: {
    branch,
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
    // Owner's settlement of a till difference (adminSettleTillDifference).
    originalVariance: N,
    varianceSettled: B,
    settledAt: D,
    settledBy: user,
    settlementNote: S,
    // Cash drawer openings during the shift (drawer.js).
    drawerOpens: N,
    noSaleOpens: N,
  },
  AuditLog: { actor: user, action: S, entityType: S, entityId: S, beforeJson: S, afterJson: S },
  Configuration: {
    restaurantName: S,
    // Accounting: cash and bank when the books started (accounting.js).
    openingBalance: N,
    efrisEnabled: B,
    efrisFrom: D,
    mtnAutoCollect: B,
    airtelAutoCollect: B,
    momoDialCode: S,
    retentionMonths: N,
    privacyContact: S,
    setupDone: B,
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
    cardEnabled: B,
    cardLabel: S,
    cardTerminalId: S,
    cardMerchantName: S,
    cashReminderHour: N,
    floatWarningPercent: N,
    defaultCommissionType: S,
    defaultCommissionPerOrder: N,
    defaultCommissionPercent: N,
    zReportHour: N,
    restaurantLat: N,
    restaurantLng: N,
    moduleRiderOrders: B,
    moduleCallIn: B,
    moduleCounter: B,
    cashDrawer: B,
    drawerOnSale: B,
    drawerOnHandover: B,
    drawerOnPayout: B,
    drawerOnShift: B,
    receiptWidth: N,
    receiptHeader: S,
    receiptFooter: S,
    autoPrintKitchen: B,
    restaurantLogo: 'File',
    // Sign-in screen pictures: [{ file, caption }] (adminSetLoginImages).
    loginImages: 'Array',
    themeInk: S,
    themeAccent: S,
  },
  MenuItem: {
    title: S,
    price: N,
    category: S,
    active: B,
    availableToday: B,
    // Branches that offer it (none: all) and where it is sold out today.
    branchIds: 'Array',
    soldOutAt: 'Array',
    sortOrder: N,
    accompanimentGroups: 'Array',
    description: S,
    image: 'File',
    archivedAt: D,
    // Minutes the kitchen needs for the dish (optional; 0 = not set).
    prepMinutes: N,
  },
  ZReport: { day: S, data: 'Object', generatedAt: D, auto: B },
  Accompaniment: {
    title: S,
    active: B,
    available: B,
    sortOrder: N,
    price: N,
    soldOutAt: 'Array',
  },
  // Purchases and expenses (spending.js).
  Supplier: {
    name: S,
    phone: S,
    email: S,
    address: S,
    tin: S,
    notes: S,
    active: B,
  },
  Purchase: {
    branch,
    purchaseCode: S,
    day: S,
    spentAt: D,
    supplier: ['Pointer', 'Supplier'],
    supplierName: S,
    category: S,
    lines: 'Array',
    total: N,
    paid: N,
    status: S,
    invoice: S,
    notes: S,
    payments: 'Array',
    recordedBy: user,
    voidedAt: D,
    voidReason: S,
    voidedBy: user,
  },
  Expense: {
    branch,
    expenseCode: S,
    day: S,
    spentAt: D,
    category: S,
    description: S,
    amount: N,
    method: S,
    payee: S,
    reference: S,
    supplier: ['Pointer', 'Supplier'],
    recordedBy: user,
    voidedAt: D,
    voidReason: S,
    voidedBy: user,
  },
  Customer: {
    email: S,
    notes: S,
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
  ErrorLog: {
    source: S,
    where: S,
    message: S,
    stack: S,
    fingerprint: S,
    count: N,
    firstSeenAt: D,
    lastSeenAt: D,
    user,
    userName: S,
    role: S,
    userAgent: S,
    url: S,
    appVersion: S,
    resolved: B,
    resolvedAt: D,
    resolvedBy: user,
    // Relay Hosted: marked fixed from the platform console.
    resolvedByPlatform: B,
  },
  PushSubscription: {
    user,
    endpoint: S,
    p256dh: S,
    auth: S,
    userAgent: S,
    lastSeenAt: D,
    // Last delivery: when a push was accepted, or why it was not.
    lastSuccessAt: D,
    lastError: S,
    lastErrorAt: D,
  },
  Secret: { key: S, value: 'Object' },
  AdminUnlock: { tokenHash: S, user, expiresAt: D },
  // Relay Hosted (docs/HOSTED.md).
  Restaurant: {
    name: S,
    code: S,
    suspended: B,
    trialEndsAt: D,
    ownerName: S,
    billingPhone: S,
    // basic | enterprise (lib/limits.js).
    plan: S,
    priceOverride: N,
    paidUntil: D,
    note: S,
    // Collected at sign-up: password reset links and Relay's emails.
    ownerEmail: S,
    // Forgot password: hash of the emailed token, and when it runs out.
    resetTokenHash: S,
    resetTokenExpires: D,
    // Chose to pay at sign-up instead of a free trial; the code it gave
    // (offers.js). Cleared by the first payment.
    payFirst: B,
    offer: 'Object',
    // Who referred this restaurant (its id), and the free months they got.
    referredBy: S,
    referralCredit: 'Object',
    // A smaller plan chosen for the next period, from the date it starts.
    nextPlan: S,
    nextPlanFrom: D,
    // What stays when it starts: { branches: [ids], members: [ids] }.
    nextPlanKeep: 'Object',
    // The restaurant as a customer in Zoho Books.
    zohoContactId: S,
  },
  SubscriptionPayment: {
    amount: N,
    currency: S,
    months: N,
    method: S,
    status: S,
    payer: S,
    externalId: S,
    providerId: S,
    message: S,
    reference: S,
    note: S,
    periodStart: D,
    periodEnd: D,
    paidAt: D,
    recordedBy: user,
    // A first payment with a code (offers.js): the price before it.
    listAmount: N,
    discount: N,
    discountCode: S,
    // period (extends the paid date) | upgrade (the difference for the days
    // left), and the plan it is for.
    kind: S,
    plan: S,
    // Zoho Books (platformAccounting.js): the invoice and payment made there.
    zohoInvoiceId: S,
    zohoPaymentId: S,
    zohoSyncedAt: D,
    zohoError: S,
  },
  // Relay Hosted plans (lib/plans.js).
  Plan: {
    key: S,
    name: S,
    description: S,
    price: N,
    // A year paid at once; empty: 10 months' price (lib/plans.js).
    annualPrice: N,
    limits: 'Object',
    features: 'Object',
    active: B,
    sortOrder: N,
  },
  // A month's earnings journal in Zoho Books (platformAccounting.js).
  AccountingPosting: {
    month: S,
    amount: N,
    invoices: N,
    zohoJournalId: S,
    postedAt: D,
    byName: S,
  },
  // Discount codes for a first payment at sign-up (offers.js).
  DiscountCode: {
    code: S,
    kind: S,
    value: N,
    minMonths: N,
    maxUses: N,
    used: N,
    expiresAt: D,
    active: B,
    note: S,
  },
  // Emails from platform staff to owners (platformBroadcast.js).
  PlatformBroadcast: {
    subject: S,
    message: S,
    audience: 'Object',
    total: N,
    sent: N,
    failed: N,
    state: S,
    byName: S,
    finishedAt: D,
  },
  PlatformSettings: {
    monthlyPrice: N,
    enterprisePrice: N,
    currency: S,
    trialDays: N,
    graceDays: N,
    supportContact: S,
    billingFrom: S,
    referralPercent: N,
    referralMonths: N,
    // The platform's WhatsApp sender (lib/whatsappSender.js), token included.
    whatsapp: 'Object',
    // The email service (lib/email.js), API key included.
    email: 'Object',
    // Zoho Books connection (platformAccounting.js), tokens included.
    zoho: 'Object',
  },
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

// PIN re-entry lockout, the rider payout round, rider availability and the
// rider's own cash limit (see lib/core.js, payouts.js, people.js).
const USER_FIELDS = {
  pinFailures: N,
  pinLockedUntil: D,
  payRound: N,
  available: B,
  maxFloat: N,
  financeCode: S,
  // Where they work (branches.js).
  branch: ['Pointer', 'Branch'],
  // Restored from a backup (restore.js).
  restoredFrom: S,
  restoredCreatedAt: D,
};

// Records restored from a backup (restore.js, lib/placed.js): the id and
// creation time they had in the backup, and links still to be rebuilt.
for (const className of [
  'Order',
  'OrderItem',
  'CashHandover',
  'TillPayout',
  'Shift',
  'AuditLog',
  'MenuItem',
  'MenuCategory',
  'Accompaniment',
  'Customer',
  'ZReport',
  'Branch',
  'Supplier',
  'Purchase',
  'Expense',
])
  Object.assign(SCHEMAS[className], {
    restoredFrom: S,
    restoredCreatedAt: D,
    restoreLinks: 'Object',
  });

// Creates missing classes with their fields, adds any missing fields to
// existing ones, and (re)applies class-level permissions to all of them.
async function applySchemas() {
  const existing = new Map((await Parse.Schema.all()).map((schema) => [schema.className, schema]));
  const created = [];
  for (const className of PROTECTED_CLASSES) {
    const schema = new Parse.Schema(className);
    const current = existing.get(className);
    const known = current ? Object.keys(current.fields || {}) : [];
    // Relay Hosted: every restaurant class points at its restaurant.
    const fields = require('./lib/tenant').SCOPED.has(className)
      ? { ...SCHEMAS[className], tenant: ['Pointer', 'Restaurant'] }
      : SCHEMAS[className];
    for (const [field, type] of Object.entries(fields)) {
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
  const needsTenant = !userFields.includes('tenant');
  if (missing.length || needsTenant) {
    const schema = new Parse.Schema('_User');
    for (const [field, type] of missing)
      if (Array.isArray(type)) schema.addField(field, type[0], { targetClass: type[1] });
      else schema.addField(field, type);
    if (needsTenant) schema.addPointer('tenant', 'Restaurant');
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

async function applySecurity({ schemas = true } = {}) {
  const updated = { createdClasses: schemas ? await applySchemas() : [] };
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
  // Door payments rejected before a rejection made the rider owe the cash:
  // put them on the rider's cash list now, the same as verifyPayment does.
  updated.rejectedDoorPayments = await eachObject(
    'Order',
    async (order) => {
      order.set({
        paymentMethod: 'cash',
        amountCollected: Number(order.get('total') || 0),
        cashStatus: 'WITH_RIDER',
        paidAtDoor: true,
      });
      await order.save(null, MASTER);
      return true;
    },
    (query) => {
      query.equalTo('status', 'DELIVERED');
      query.equalTo('paymentMethod', 'mobile_money');
      query.equalTo('paymentStatus', 'REJECTED');
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
  for (const className of ['Supplier', 'Purchase', 'Expense'])
    updated[className] = await eachObject(className, (o) =>
      saveAcl(o, readAcl(null, ['admin', 'finance'])),
    );
  updated.Branch = await eachObject('Branch', (o) =>
    saveAcl(o, readAcl(null, ['admin', 'finance', 'cashier', 'rider'])),
  );
  updated._User = await eachObject(Parse.User, async (user) => {
    const role = await getRoleName(user);
    let changed = false;
    const codeField =
      role === 'rider'
        ? 'riderCode'
        : role === 'cashier'
          ? 'cashierCode'
          : role === 'finance'
            ? 'financeCode'
            : null;
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
  // Anything saved without a branch (restored, or from before) goes in the
  // main branch, once the restaurant has branches.
  const branches = require('./branches');
  const main = await branches.mainBranch();
  if (main) updated.branchless = await branches.backfill(main);
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
  // Relay Hosted: once per restaurant (each has its own records and roles).
  const updated = await require('./restaurants').forEachRestaurant(() => applySecurity());
  return `Security applied: ${JSON.stringify(updated)}`;
});

Parse.Cloud.define('adminApplySecurity', async (request) => {
  const actor = await requireAdminUnlock(request);
  const updated = await applySecurity();
  await audit(actor, 'security.applied', { className: 'Security', id: 'all' }, null, updated);
  return updated;
});

// Relay Hosted: platform staff apply the rules for every restaurant after a
// deploy, one restaurant per call so no call runs long. The class rules and
// fields are shared, so they are applied once, on the first call; each call
// then repairs one restaurant's records (suspended ones too).
// { after } → { restaurant, updated, next, total }; call again with
// after: next until next is null.
Parse.Cloud.define('platformApplySecurity', async (request) => {
  const { requirePlatform } = require('./restaurants');
  const tenancy = require('./lib/tenant');
  const actor = await requirePlatform(request);
  const after = request.params?.after;
  if (after !== undefined && after !== null && !/^[A-Za-z0-9]{1,32}$/.test(String(after)))
    throw invalid('Bad restaurant');
  let createdClasses = [];
  if (!after) createdClasses = await tenancy.withoutTenant(() => applySchemas());
  const [row, following] = await tenancy.withoutTenant(() => {
    const query = new Parse.Query('Restaurant');
    query.ascending('objectId');
    if (after) query.greaterThan('objectId', String(after));
    query.limit(2);
    return query.find(MASTER);
  });
  const total = after
    ? null
    : await tenancy.withoutTenant(() =>
        // A filter keeps Postgres from answering with an estimate.
        new Parse.Query('Restaurant').exists('objectId').count(MASTER),
      );
  let updated = null;
  let failed = '';
  if (row)
    try {
      updated = await tenancy.runAs(
        row.id,
        () => applySecurity({ schemas: false }),
        row.get('code'),
      );
    } catch (error) {
      // Reported and skipped, so one restaurant cannot hold up the others.
      failed = String(error?.message || error).slice(0, 200);
    }
  if (!after)
    await tenancy.withoutTenant(() =>
      audit(actor, 'platform.security_applied', { className: 'Security', id: 'all' }, null, {
        restaurants: total,
        createdClasses,
      }),
    );
  return {
    createdClasses,
    total,
    restaurant: row
      ? { id: row.id, name: row.get('name') || '', code: row.get('code') || '' }
      : null,
    updated,
    failed,
    next: following ? row.id : null,
  };
});

module.exports = { applySecurity };
