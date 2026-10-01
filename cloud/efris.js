// Tax (EFRIS), Admin → Tax. Optional: when the owner has connected the
// restaurant's EFRIS account and switched it on, every sale gets a fiscal
// document number (FDN), verification code and QR code from URA, printed on
// its receipt.
//
// Setup (adminSaveEfrisSettings, adminTestEfris): the TIN, the device
// number (a virtual device from the EFRIS portal) and the private key whose
// certificate was uploaded to the portal; testing the connection reads the
// taxpayer's details and URA's units of measure. The menu is registered as
// goods (T130) before the first sale, and again when a dish is renamed.
//
// A sale is issued (T109) once the order is delivered / served, or paid,
// whichever comes first: from the Order afterSave hook, when its receipt is
// printed, or by a later retry (sweepEfris, run while staff use the app).
// The order code is sent as the seller's reference with EFRIS's duplicate
// check on, so a sale can never be issued twice; if EFRIS already has it,
// the FDN is read back (T106, T108).
//
// The key and settings live in the private Secret class; only the on/off
// switch and the start date are in Configuration.

const {
  MASTER,
  audit,
  claimOnce,
  invalid,
  loadConfig,
  personName,
  requireRole,
} = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');
const api = require('./lib/efrisApi');
const { log, errorMessage } = require('./lib/log');

const SECRET_KEY = 'efris';
const ENVIRONMENTS = ['test', 'production'];
const KINDS = ['receipt', 'invoice'];
const DELIVERY_CODE = 'RELAY-DELIVERY';
const MAX_ATTEMPTS = 8;
// Seller details the owner can edit; filled from EFRIS when empty.
const TEXT_FIELDS = {
  tin: 20,
  ninBrn: 100,
  legalName: 256,
  businessName: 256,
  address: 500,
  mobilePhone: 30,
  emailAddress: 50,
  placeOfBusiness: 500,
  deviceNo: 20,
  commodityCategoryId: 18,
  unitOfMeasure: 3,
  remarks: 500,
};

async function secretRow() {
  const query = new Parse.Query('Secret');
  query.equalTo('key', SECRET_KEY);
  query.ascending('createdAt');
  return query.first(MASTER);
}

async function loadSettings() {
  const row = await secretRow();
  return { row, settings: { environment: 'test', ...(row?.get('value') || {}) } };
}

async function saveSettings(row, settings) {
  const target = row || new Parse.Object('Secret');
  target.set({ key: SECRET_KEY, value: settings });
  target.setACL(new Parse.ACL());
  await target.save(null, MASTER);
  return target;
}

// Everything EFRIS needs before a sale can be issued.
function missing(settings) {
  const need = [
    ['tin', 'TIN'],
    ['deviceNo', 'device number'],
    ['privateKey', 'private key'],
    ['legalName', 'legal name'],
    ['emailAddress', 'email address'],
    ['commodityCategoryId', 'commodity category'],
    ['unitOfMeasure', 'unit of measure'],
  ];
  return need.filter(([field]) => !String(settings[field] || '').trim()).map(([, label]) => label);
}

// The restaurant's location for the envelope (EFRIS asks for one).
async function withLocation(settings) {
  const { values } = await loadConfig();
  const center = values.mapCenter;
  return center ? { ...settings, latitude: center.lat, longitude: center.lng } : settings;
}

function view(settings, values) {
  return {
    enabled: values.efrisEnabled === true,
    since: values.efrisFrom || null,
    environment: settings.environment || 'test',
    ...Object.fromEntries(Object.keys(TEXT_FIELDS).map((field) => [field, settings[field] || ''])),
    taxCategory: settings.taxCategory || '',
    invoiceKind: settings.invoiceKind || '',
    keyLoaded: !!settings.privateKey,
    keyName: settings.keyName || '',
    // A key made here (adminGenerateEfrisKey): its certificate can be
    // downloaded again for the EFRIS portal.
    certificate: settings.certificate
      ? {
          validUntil: settings.certificateValidUntil || '',
          fingerprint: settings.certificateFingerprint || '',
        }
      : null,
    units: settings.units || [],
    lastTest: settings.lastTest || null,
    goodsRegistered: Object.keys(settings.goods || {}).length,
    missing: missing(settings),
    taxOptions: Object.entries(api.TAX).map(([value, tax]) => ({ value, label: tax.label })),
  };
}

// Owner: the connection (the private key is never sent back).
Parse.Cloud.define('adminGetEfrisSettings', async (request) => {
  await requireAdminUnlock(request);
  const [{ settings }, { values }] = await Promise.all([loadSettings(), loadConfig()]);
  const counts = {};
  for (const status of ['issued', 'failed']) {
    const query = new Parse.Query('Order');
    query.equalTo('efrisStatus', status);
    counts[status] = await query.count(MASTER).catch(() => 0);
  }
  return { ...view(settings, values), counts };
});

// Owner: save the connection. { environment, ...TEXT_FIELDS, taxCategory,
// invoiceKind, key (file, base64), keyPassword, keyName, enabled }. An
// empty key keeps the stored one.
Parse.Cloud.define('adminSaveEfrisSettings', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const { row, settings: before } = await loadSettings();
  const settings = { ...before };
  if (p.environment !== undefined) {
    if (!ENVIRONMENTS.includes(p.environment)) throw invalid('Choose test or live EFRIS');
    settings.environment = p.environment;
  }
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (p[field] === undefined) continue;
    const value = String(p[field] ?? '').trim();
    if (value.length > max) throw invalid(`${field} is too long`);
    settings[field] = value;
  }
  if (settings.tin && !/^\d{10}$/.test(settings.tin)) throw invalid('A TIN has 10 digits');
  if (settings.emailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.emailAddress))
    throw invalid('Enter a valid email address');
  if (p.taxCategory !== undefined) {
    if (p.taxCategory && !api.TAX[p.taxCategory]) throw invalid('Choose a tax rate');
    settings.taxCategory = p.taxCategory || '';
  }
  if (p.invoiceKind !== undefined) {
    if (p.invoiceKind && !KINDS.includes(p.invoiceKind))
      throw invalid('Choose receipts or invoices');
    settings.invoiceKind = p.invoiceKind || '';
  }
  if (p.key) {
    if (String(p.key).length > 200000) throw invalid('That key file is too large');
    try {
      settings.privateKey = api.privateKeyPem(p.key, p.keyPassword);
    } catch (error) {
      throw invalid(error.message);
    }
    settings.keyName = String(p.keyName || 'private key').slice(0, 120);
    // An uploaded key has its own certificate, already on the portal.
    delete settings.certificate;
    delete settings.certificateDer;
    delete settings.certificateValidUntil;
    delete settings.certificateFingerprint;
  }
  // A new account, device or key must be tested again.
  const identity = (s) => [s.environment, s.tin, s.deviceNo, s.privateKey].join('|');
  if (identity(settings) !== identity(before)) {
    delete settings.lastTest;
    delete settings.goods;
  }
  const { object: config, values } = await loadConfig();
  const enabled = p.enabled === undefined ? values.efrisEnabled === true : p.enabled === true;
  // Checked when switching on. Once on, a new key or device can be saved
  // (sales are retried until its connection is tested and works).
  if (enabled && !(await efrisInPlan())) throw invalid('EFRIS receipts are not part of your plan');
  if (enabled && values.efrisEnabled !== true) {
    const gaps = missing(settings);
    if (gaps.length) throw invalid(`Add the ${gaps.join(', ')} before switching EFRIS on`);
    if (!settings.lastTest?.ok) throw invalid('Test the connection before switching EFRIS on');
    if (!settings.taxCategory || !settings.invoiceKind)
      throw invalid('Choose the tax rate and receipts or invoices before switching EFRIS on');
  }
  await saveSettings(row, settings);
  if (config && enabled !== (values.efrisEnabled === true)) {
    config.set('efrisEnabled', enabled);
    // Only sales from now on are issued, never older ones.
    if (enabled) config.set('efrisFrom', new Date());
    await config.save(null, MASTER);
  }
  await audit(
    actor,
    'efris.settings_saved',
    { className: 'Secret', id: SECRET_KEY },
    { enabled: values.efrisEnabled === true, environment: before.environment, tin: before.tin },
    {
      enabled,
      environment: settings.environment,
      tin: settings.tin,
      keyChanged: !!p.key,
    },
  );
  const fresh = await loadConfig();
  return view(settings, fresh.values);
});

// Owner: make a new key pair here, so no tools are needed. The private key
// is kept (like an uploaded one); the certificate is downloaded and uploaded
// on the EFRIS portal. Replacing a key in use needs { replace: true }: sales
// fail until the new certificate is on the portal.
Parse.Cloud.define('adminGenerateEfrisKey', async (request) => {
  const actor = await requireAdminUnlock(request);
  const { row, settings } = await loadSettings();
  if (!/^\d{10}$/.test(settings.tin || ''))
    throw invalid('Save your 10-digit TIN first: it goes into the certificate');
  if (settings.privateKey && request.params?.replace !== true)
    throw invalid(
      'A private key is already saved. Replace it only if you will upload the new certificate',
    );
  const { values } = await loadConfig();
  const made = api.generateKeyPair({
    tin: settings.tin,
    name: settings.legalName || values.restaurantName || '',
  });
  const replaced = !!settings.privateKey;
  Object.assign(settings, {
    privateKey: made.privateKey,
    keyName: `Made by RelayEats on ${new Date().toISOString().slice(0, 10)}`,
    certificate: made.certificate,
    certificateDer: made.certificateDer,
    certificateValidUntil: made.validUntil,
    certificateFingerprint: made.fingerprint,
  });
  // A new key must be tested again (and its goods are the same TIN's).
  delete settings.lastTest;
  await saveSettings(row, settings);
  await audit(actor, 'efris.key_generated', { className: 'Secret', id: SECRET_KEY }, null, {
    replaced,
    fingerprint: made.fingerprint,
    validUntil: made.validUntil,
  });
  return { ...certificateFiles(settings), view: view(settings, values) };
});

function certificateFiles(settings) {
  const base = `efris-${settings.tin || 'relay'}`;
  return {
    crt: { name: `${base}.crt`, text: settings.certificate },
    cer: { name: `${base}.cer`, base64: settings.certificateDer },
    fingerprint: settings.certificateFingerprint,
    validUntil: settings.certificateValidUntil,
  };
}

// Owner: the certificate of a key made here, to upload on the portal again.
Parse.Cloud.define('adminGetEfrisCertificate', async (request) => {
  await requireAdminUnlock(request);
  const { settings } = await loadSettings();
  if (!settings.certificate)
    throw invalid(
      'No certificate here: the key was uploaded, so its certificate is the one you made',
    );
  return certificateFiles(settings);
});

// Owner: check the connection and read the taxpayer, device and URA's units.
Parse.Cloud.define('adminTestEfris', async (request) => {
  const actor = await requireAdminUnlock(request);
  const { row, settings } = await loadSettings();
  for (const field of ['tin', 'deviceNo', 'privateKey'])
    if (!settings[field])
      throw invalid('Save the TIN, device number and private key, then test the connection');
  const connection = await withLocation(settings);
  let lastTest;
  try {
    const login = (await api.login(connection)) || {};
    const dictionary = (await api.dictionary(connection)) || {};
    const taxpayer = login.taxpayer || {};
    const taxTypes = (login.taxType || []).map((t) => String(t.taxTypeCode));
    const vatRegistered = taxTypes.includes('301');
    const units = (dictionary.rateUnit || [])
      .map((u) => ({ value: String(u.value), name: String(u.name) }))
      .filter((u) => u.value);
    const ugx = (dictionary.currencyType || []).find((c) => String(c.name) === 'UGX');
    settings.units = units;
    settings.currencyValue = ugx ? String(ugx.value) : '101';
    // Fill what the owner has not typed from EFRIS's own records.
    const fill = {
      legalName: taxpayer.legalName,
      businessName: taxpayer.businessName,
      ninBrn: taxpayer.ninBrn,
      emailAddress: taxpayer.contactEmail,
      mobilePhone: taxpayer.contactMobile || taxpayer.contactNumber,
      placeOfBusiness: taxpayer.placeOfBusiness,
      address: taxpayer.placeOfBusiness,
    };
    for (const [field, value] of Object.entries(fill))
      if (!settings[field] && value) settings[field] = String(value).trim();
    if (!settings.invoiceKind) settings.invoiceKind = vatRegistered ? 'invoice' : 'receipt';
    if (!settings.taxCategory) settings.taxCategory = vatRegistered ? 'standard' : 'exempt';
    lastTest = {
      ok: true,
      at: new Date().toISOString(),
      message: '',
      taxpayer: String(taxpayer.legalName || taxpayer.businessName || ''),
      tinMatches: !taxpayer.tin || String(taxpayer.tin) === settings.tin,
      vatRegistered,
      deviceStatus: String(login.device?.deviceStatus || ''),
      environment: String(login.environment ?? ''),
      unitCount: units.length,
    };
  } catch (error) {
    lastTest = { ok: false, at: new Date().toISOString(), message: errorMessage(error) };
  }
  settings.lastTest = lastTest;
  await saveSettings(row, settings);
  await audit(actor, 'efris.tested', { className: 'Secret', id: SECRET_KEY }, null, {
    ok: lastTest.ok,
    message: lastTest.message,
  });
  const { values } = await loadConfig();
  return view(settings, values);
});

// ---- Goods -------------------------------------------------------------

const menuCode = (menuItem) => `RLY-${menuItem.id}`;

// Registers (or renames) goods EFRIS does not know yet. entries:
// [{ code, name, price }] → failures [{ code, name, message }].
async function ensureGoods(connection, settings, entries, { force = false } = {}) {
  const known = { ...(settings.goods || {}) };
  const pending = entries.filter((entry) => force || known[entry.code]?.name !== entry.name);
  if (!pending.length) return { failures: [], changed: false };
  const failures = [];
  let changed = false;
  for (let i = 0; i < pending.length; i += 50) {
    const part = pending.slice(i, i + 50);
    const upload = (list) =>
      api.uploadGoods(
        connection,
        list.map((entry) =>
          api.goodsEntry({
            ...entry,
            settings,
            currency: settings.currencyValue || '101',
            modify: !!known[entry.code] || entry.modify,
          }),
        ),
      );
    let refused = (await upload(part)) || [];
    // Already registered (602): update it instead.
    const exists = refused.filter((r) => String(r.returnCode) === '602');
    if (exists.length) {
      const again = part
        .filter((entry) => exists.some((r) => r.goodsCode === entry.code))
        .map((entry) => ({ ...entry, modify: true }));
      const second = (await upload(again)) || [];
      refused = [...refused.filter((r) => String(r.returnCode) !== '602'), ...second];
    }
    for (const entry of part) {
      const failure = refused.find((r) => r.goodsCode === entry.code);
      if (failure)
        failures.push({
          code: entry.code,
          name: entry.name,
          message: `${failure.returnMessage || 'refused'} (${failure.returnCode || '?'})`,
        });
      else {
        known[entry.code] = { name: entry.name };
        changed = true;
      }
    }
  }
  settings.goods = known;
  return { failures, changed };
}

async function menuEntries() {
  const query = new Parse.Query('MenuItem');
  query.doesNotExist('archivedAt');
  query.limit(1000);
  const items = await query.find(MASTER);
  return [
    ...items.map((item) => ({
      code: menuCode(item),
      name: String(item.get('title') || 'Dish'),
      price: Number(item.get('price') || 0),
    })),
    { code: DELIVERY_CODE, name: 'Delivery', price: 0 },
  ];
}

// Owner: register the whole menu with EFRIS (also done before each sale).
Parse.Cloud.define('adminRegisterEfrisGoods', async (request) => {
  const actor = await requireAdminUnlock(request);
  const { row, settings } = await loadSettings();
  const gaps = missing(settings);
  if (gaps.length) throw invalid(`Add the ${gaps.join(', ')} first`);
  const entries = await menuEntries();
  let result;
  try {
    result = await ensureGoods(await withLocation(settings), settings, entries, {
      force: request.params?.all === true,
    });
  } catch (error) {
    throw invalid(errorMessage(error));
  }
  await saveSettings(row, settings);
  await audit(actor, 'efris.goods_registered', { className: 'Secret', id: SECRET_KEY }, null, {
    count: entries.length - result.failures.length,
    failed: result.failures.length,
  });
  return { registered: Object.keys(settings.goods || {}).length, failures: result.failures };
});

// ---- Sales -------------------------------------------------------------

const paid = (order) =>
  !order.get('billOpen') &&
  (order.get('paymentMethod') === 'cash'
    ? ['IN_TILL', 'RECONCILED'].includes(order.get('cashStatus'))
    : order.get('paymentStatus') === 'VERIFIED');

// A sale is due once it is delivered / served or paid, from the day EFRIS
// was switched on.
function due(order, values) {
  if (values.efrisEnabled !== true) return false;
  if (order.get('efrisStatus') === 'issued') return false;
  if (order.get('status') === 'CANCELLED') return false;
  const placed = order.get('restoredCreatedAt') || order.createdAt;
  if (!values.efrisFrom || !placed || placed < new Date(values.efrisFrom)) return false;
  return order.get('status') === 'DELIVERED' || paid(order);
}

async function saleLines(order) {
  const query = new Parse.Query('OrderItem');
  query.equalTo('order', order);
  query.include('menuItem');
  query.ascending('createdAt');
  query.limit(200);
  const items = await query.find(MASTER);
  const lines = items
    .filter((item) => Number(item.get('quantity')) > 0)
    .map((item) => {
      const qty = Number(item.get('quantity'));
      const menuItem = item.get('menuItem');
      return {
        code: menuItem ? menuCode(menuItem) : `RLY-${item.id}`,
        name: String(menuItem?.get('title') || item.get('itemNameSnapshot') || 'Dish'),
        qty,
        unitPrice: Number(item.get('lineTotal') || 0) / qty,
        price: Number(menuItem?.get('price') || item.get('unitPriceSnapshot') || 0),
      };
    });
  const fee = Number(order.get('deliveryFee') || 0);
  if (fee > 0)
    lines.push({ code: DELIVERY_CODE, name: 'Delivery', qty: 1, unitPrice: fee, price: 0 });
  return lines;
}

// EFRIS already has this sale (a retry after a lost answer): read it back.
async function recover(connection, settings, reference) {
  const found = await api.queryInvoices(connection, {
    referenceNo: reference,
    invoiceKind: settings.invoiceKind === 'invoice' ? '1' : '2',
    invoiceType: '1',
    pageNo: '1',
    pageSize: '10',
  });
  const record = (found?.records || [])[0];
  if (!record?.invoiceNo) throw new api.EfrisError('EFRIS has this sale but did not return it');
  const detail = await api.invoiceDetails(connection, record.invoiceNo);
  return detail;
}

function saved(order, answer) {
  const basic = answer?.basicInformation || {};
  if (!basic.invoiceNo) throw new api.EfrisError('EFRIS did not return a fiscal document number');
  order.set({
    efrisStatus: 'issued',
    efrisFdn: String(basic.invoiceNo),
    efrisVerification: String(basic.antifakeCode || ''),
    efrisInvoiceId: String(basic.invoiceId || ''),
    efrisQr: String(answer?.summary?.qrCode || ''),
    efrisIssuedAt: new Date(),
    efrisError: '',
  });
}

async function waitForOther(order) {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const fresh = await new Parse.Query('Order').get(order.id, MASTER);
    if (['issued', 'failed'].includes(fresh.get('efrisStatus'))) return fresh;
  }
  return order;
}

// Issues one sale if it is due. Never throws; the order says how it went.
// Relay Hosted plans may leave EFRIS out (lib/limits.js).
const efrisInPlan = async () => (await require('./lib/limits').features()).efris !== false;

async function issue(orderOrId, { actor = null, force = false } = {}) {
  if (!(await efrisInPlan())) return null;
  let order;
  try {
    order =
      typeof orderOrId === 'string'
        ? await new Parse.Query('Order')
            .include(['tillCashier', 'placedBy', 'cashier', 'createdBy'])
            .get(orderOrId, MASTER)
        : orderOrId;
    const { values } = await loadConfig();
    if (!due(order, values)) return order;
    const attempts = Number(order.get('efrisAttempts') || 0);
    if (!force && attempts >= MAX_ATTEMPTS) return order;
    // One attempt at a time per order; a second caller (a receipt being
    // printed) waits for the first to finish.
    if (!(await claimOnce(`efris-${order.id}-${attempts}`))) return waitForOther(order);
    order.set({ efrisAttempts: attempts + 1, efrisAttemptAt: new Date() });
    const { row, settings } = await loadSettings();
    const gaps = missing(settings);
    if (gaps.length) throw new api.EfrisError(`Tax settings incomplete: ${gaps.join(', ')}`);
    const connection = await withLocation(settings);
    const lines = await saleLines(order);
    if (!lines.length) throw new api.EfrisError('The order has no items');
    const goods = await ensureGoods(connection, settings, lines);
    if (goods.changed) await saveSettings(row, settings);
    if (goods.failures.length)
      throw new api.EfrisError(
        `EFRIS refused the dish ${goods.failures[0].name}: ${goods.failures[0].message}`,
      );
    const staff =
      order.get('tillCashier') ||
      order.get('placedBy') ||
      order.get('cashier') ||
      order.get('createdBy');
    const invoice = api.buildInvoice({
      settings,
      reference: order.get('orderCode'),
      operator: staff?.get ? personName(staff) : '',
      buyer: { name: order.get('customerName'), phone: order.get('customerPhone') },
      lines,
      payment: order.get('paymentMethod'),
      issuedAt: new Date(),
    });
    let answer;
    try {
      answer = await api.uploadInvoice(connection, invoice);
    } catch (error) {
      if (error.code === '2253')
        answer = await recover(connection, settings, order.get('orderCode'));
      else if (['2122', '2123'].includes(error.code)) {
        // EFRIS lost track of a dish: register it again, then retry once.
        const again = await ensureGoods(connection, settings, lines, { force: true });
        await saveSettings(row, settings);
        if (again.failures.length) throw error;
        answer = await api.uploadInvoice(connection, invoice);
      } else throw error;
    }
    saved(order, answer);
    await order.save(null, MASTER);
    // Issued is issued: a failed log line must not mark the sale as failed.
    await audit(actor, 'efris.issued', order, null, {
      fdn: order.get('efrisFdn'),
      code: order.get('orderCode'),
    }).catch((error) =>
      log('warn', 'efris.audit_failed', { order: order.id, message: errorMessage(error) }),
    );
    log('info', 'efris.issued', { order: order.id, fdn: order.get('efrisFdn') });
  } catch (error) {
    if (!order) return null;
    order.set({ efrisStatus: 'failed', efrisError: errorMessage(error).slice(0, 500) });
    await order.save(null, MASTER).catch(() => undefined);
    log('warn', 'efris.failed', { order: order.id, message: errorMessage(error) });
  }
  return order;
}

// Order afterSave: sales that just became due go to EFRIS in the background.
function orderSaved(order) {
  if (order.get('efrisStatus')) return;
  const maybe =
    order.get('status') === 'DELIVERED' ||
    order.get('paymentStatus') === 'VERIFIED' ||
    ['IN_TILL', 'RECONCILED'].includes(order.get('cashStatus'));
  if (!maybe || order.get('status') === 'CANCELLED') return;
  // A moment later: a new order's lines are saved just after the order.
  new Promise((resolve) => setTimeout(resolve, Number(process.env.RELAY_EFRIS_DELAY_MS ?? 2000)))
    .then(() => loadConfig())
    .then(({ values }) => (values.efrisEnabled === true ? issue(order.id) : null))
    .catch((error) =>
      log('warn', 'efris.hook_failed', { order: order.id, message: errorMessage(error) }),
    );
}

// Retries sales EFRIS refused or could not be reached for (while staff use
// the app; at most every minute per server, a few at a time).
async function sweepEfris(limit = 3) {
  if (!require('./lib/throttle').due('efris-sweep', 60000)) return 0;
  const { values } = await loadConfig();
  if (values.efrisEnabled !== true) return 0;
  const query = new Parse.Query('Order');
  query.equalTo('efrisStatus', 'failed');
  query.lessThan('efrisAttempts', MAX_ATTEMPTS);
  query.lessThan('efrisAttemptAt', new Date(Date.now() - 120000));
  query.ascending('efrisAttemptAt');
  query.limit(limit);
  const rows = await query.find(MASTER).catch(() => []);
  for (const row of rows) await issue(row.id);
  return rows.length;
}

// What a receipt or the order page shows.
async function receiptView(order, values) {
  if (!order.get('efrisStatus') && values.efrisEnabled !== true) return null;
  const { settings } = await loadSettings();
  return {
    status: order.get('efrisStatus') || (due(order, values) ? 'pending' : 'not_due'),
    fdn: order.get('efrisFdn') || '',
    verification: order.get('efrisVerification') || '',
    qr: order.get('efrisQr') || '',
    issuedAt: order.get('efrisIssuedAt') || null,
    error: order.get('efrisError') || '',
    tin: settings.tin || '',
    legalName: settings.legalName || '',
    kind: settings.invoiceKind === 'invoice' ? 'invoice' : 'receipt',
    test: settings.environment !== 'production',
  };
}

// Staff: issue (or retry) one sale now. { orderId } → the receipt's view.
Parse.Cloud.define('issueEfrisReceipt', async (request) => {
  const { user: actor } = await requireRole(request, ['cashier', 'admin', 'finance']);
  const id = String(request.params?.orderId || '');
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw invalid('Unknown order');
  const { values } = await loadConfig();
  if (values.efrisEnabled !== true) throw invalid('EFRIS is not switched on (Admin → Tax)');
  if (!(await efrisInPlan())) throw invalid('EFRIS receipts are not part of your plan');
  const order = await issue(id, { actor, force: true });
  if (!order) throw invalid('Unknown order');
  if (!due(order, values) && order.get('efrisStatus') !== 'issued')
    throw invalid('This order is not complete yet: it is issued once delivered, served or paid');
  return receiptView(order, values);
});

// Owner and finance: the fiscal receipts of the sales in a range, to follow
// up refused or unsent ones (Admin → Tax receipts). { from, to, branchId?,
// status?: 'issued' | 'failed' | 'pending' }
Parse.Cloud.define('listEfrisReceipts', async (request) => {
  await requireRole(request, ['admin', 'finance']);
  const p = request.params;
  const { values } = await loadConfig();
  const { resolveRange } = require('./lib/dates');
  const range = resolveRange(p, values.timezone, { defaultDays: 7 });
  if (range.error) throw invalid(range.error);
  const branch = await require('./branches').branchParam(p.branchId);
  const query = require('./lib/placed').createdIn('Order', range);
  if (branch) query.equalTo('branch', branch);
  query.notEqualTo('status', 'CANCELLED');
  const rows = await require('./lib/core').findAll(query);
  const statusOf = (order) =>
    order.get('efrisStatus') || (due(order, values) ? 'pending' : 'not_due');
  const all = rows
    .map((order) => ({
      id: order.id,
      code: order.get('orderCode'),
      at: require('./lib/placed').placedAt(order),
      total: Number(order.get('total') || 0),
      customer: order.get('customerName') || '',
      status: statusOf(order),
      fdn: order.get('efrisFdn') || '',
      error: order.get('efrisError') || '',
      attempts: Number(order.get('efrisAttempts') || 0),
      issuedAt: order.get('efrisIssuedAt') || null,
    }))
    .filter((row) => row.status !== 'not_due')
    .sort((a, b) => b.at - a.at);
  const count = (status) => all.filter((row) => row.status === status).length;
  return {
    enabled: values.efrisEnabled === true,
    counts: { issued: count('issued'), failed: count('failed'), pending: count('pending') },
    rows: p.status ? all.filter((row) => row.status === p.status) : all,
  };
});

module.exports = { issue, orderSaved, sweepEfris, receiptView, due };
