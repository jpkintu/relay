// Automatic mobile money (Admin → Payments). When the owner has added the
// restaurant's MTN MoMo and/or Airtel Money API keys and switched automatic
// payments on, a rider or cashier can leave the transaction ID empty: Relay
// sends a payment request to the customer's phone, the customer approves it
// with their mobile money PIN, and the payment is confirmed on its own (no
// cashier check). The typed transaction ID and the cashier's check still
// work as before, and are the fallback when a request fails.
//
// Flow: checkMobileMoney (payments.js) marks the order "queued" → the Order
// afterSave hook below sends the request → the app asks checkPaymentRequest
// every few seconds (and staff screens sweep open requests) → the payment is
// settled as confirmed or not received exactly as a cashier would.
//
// Keys live in the private Secret class and are never sent back to the app
// in full. The on/off switches are in Configuration so every screen knows.

const crypto = require('crypto');
const {
  MASTER,
  audit,
  claimOnce,
  forbidden,
  getRoleName,
  invalid,
  loadConfig,
  readAcl,
  requireUser,
} = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');
const api = require('./lib/momoApi');
const { log, errorMessage } = require('./lib/log');

const SECRET_KEY = 'mobileMoneyApi';
const PROVIDERS = {
  mtn: {
    label: 'MTN MoMo',
    toggle: 'mtnAutoCollect',
    secrets: ['subscriptionKey', 'apiUser', 'apiKey'],
    plain: ['environment', 'targetEnvironment'],
  },
  airtel: {
    label: 'Airtel Money',
    toggle: 'airtelAutoCollect',
    secrets: ['clientId', 'clientSecret'],
    plain: ['environment', 'country'],
  },
};
const ENVIRONMENTS = ['sandbox', 'production'];
// A request the customer has not answered in this time is given up.
const EXPIRE_MINUTES = 15;

async function secretRow() {
  const query = new Parse.Query('Secret');
  query.equalTo('key', SECRET_KEY);
  query.ascending('createdAt');
  return query.first(MASTER);
}

async function loadKeys() {
  const row = await secretRow();
  const value = row?.get('value') || {};
  return { mtn: value.mtn || {}, airtel: value.airtel || {} };
}

const mask = (value) => {
  const text = String(value || '');
  if (!text) return '';
  return text.length <= 6 ? '••••' : `••••${text.slice(-4)}`;
};

const configured = (provider, keys) =>
  PROVIDERS[provider].secrets.every((field) => String(keys[field] || '').trim());

// Owner: what is set up (keys masked).
Parse.Cloud.define('adminGetPaymentSettings', async (request) => {
  await requireAdminUnlock(request);
  const [{ values }, keys] = await Promise.all([loadConfig(), loadKeys()]);
  const view = {};
  for (const [provider, meta] of Object.entries(PROVIDERS)) {
    const own = keys[provider];
    view[provider] = {
      enabled: values[meta.toggle] === true,
      configured: configured(provider, own),
      environment: own.environment || 'sandbox',
      ...(provider === 'mtn' && { targetEnvironment: own.targetEnvironment || 'mtnuganda' }),
      ...(provider === 'airtel' && { country: own.country || 'UG' }),
      keys: Object.fromEntries(meta.secrets.map((field) => [field, mask(own[field])])),
      lastTest: own.lastTest || null,
    };
  }
  return {
    ...view,
    dialCode: values.momoDialCode || '256',
    currency: values.currencyCode,
    // What each MTN test number does (test environment only).
    mtnTestNumbers: api.MTN_TEST_NUMBERS,
  };
});

// Owner: save one provider. Empty key fields keep what is stored, so keys
// never have to be shown again to change the environment or switch it off.
// { provider, enabled, environment, targetEnvironment | country, ...keys }
Parse.Cloud.define('adminSavePaymentSettings', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params || {};
  const meta = PROVIDERS[p.provider];
  if (!meta) throw invalid('Choose MTN MoMo or Airtel Money');
  const environment = String(p.environment || 'sandbox');
  if (!ENVIRONMENTS.includes(environment)) throw invalid('Choose test (sandbox) or live');
  const row = (await secretRow()) || new Parse.Object('Secret');
  const all = { mtn: {}, airtel: {}, ...(row.get('value') || {}) };
  const own = { ...all[p.provider], environment };
  const changed = [];
  for (const field of meta.secrets) {
    const value = String(p[field] ?? '').trim();
    if (value) {
      if (value.length > 500) throw invalid('That key is too long');
      if (value !== own[field]) changed.push(field);
      own[field] = value;
    }
  }
  if (p.provider === 'mtn') {
    const target = String(p.targetEnvironment || own.targetEnvironment || 'mtnuganda').trim();
    if (!/^[a-z0-9]{3,30}$/.test(target)) throw invalid('Target environment looks like mtnuganda');
    own.targetEnvironment = target;
  }
  if (p.provider === 'airtel') {
    const country = String(p.country || own.country || 'UG')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw invalid('Country is two letters, e.g. UG');
    own.country = country;
  }
  if (changed.length || environment !== all[p.provider].environment) delete own.lastTest;
  const enabled = p.enabled === true;
  if (enabled && !configured(p.provider, own))
    throw invalid(`Add all the ${meta.label} keys before switching automatic payments on`);
  all[p.provider] = own;
  row.set({ key: SECRET_KEY, value: all });
  row.setACL(new Parse.ACL());
  await row.save(null, MASTER);
  const { object } = await loadConfig();
  const config = object || new Parse.Object('Configuration');
  const before = { enabled: config.get(meta.toggle) === true };
  config.set(meta.toggle, enabled);
  if (p.dialCode !== undefined) {
    const dial = String(p.dialCode).replace(/[^\d]/g, '');
    if (!/^\d{1,4}$/.test(dial)) throw invalid('Country calling code, e.g. 256');
    config.set('momoDialCode', dial);
  }
  config.setACL(readAcl(null, ['admin']));
  await config.save(null, MASTER);
  api.forgetToken(p.provider === 'mtn' ? api.mtnKey(own) : api.airtelKey(own));
  // The keys themselves never go into the audit log, only which changed.
  await audit(actor, 'payment.settings_saved', config, before, {
    provider: p.provider,
    enabled,
    environment,
    keysChanged: changed,
  });
  return { saved: true, enabled };
});

// Owner: check the keys by asking the provider for an access token.
Parse.Cloud.define('adminTestPaymentConnection', async (request) => {
  await requireAdminUnlock(request);
  const provider = String(request.params?.provider || '');
  if (!PROVIDERS[provider]) throw invalid('Choose MTN MoMo or Airtel Money');
  const row = await secretRow();
  const all = row?.get('value') || {};
  const own = all[provider] || {};
  if (!configured(provider, own)) throw invalid(`Add the ${PROVIDERS[provider].label} keys first`);
  let result;
  try {
    if (provider === 'mtn') {
      api.forgetToken(api.mtnKey(own));
      await api.mtnToken(own);
    } else {
      api.forgetToken(api.airtelKey(own));
      await api.airtelToken(own);
    }
    result = { ok: true, message: 'Connected: the keys work.' };
  } catch (error) {
    result = { ok: false, message: errorMessage(error) };
  }
  all[provider] = { ...own, lastTest: { ...result, at: new Date().toISOString() } };
  row.set('value', all);
  await row.save(null, MASTER);
  return result;
});

// Owner, MTN sandbox only: create the sandbox API user and key from the
// subscription key (MTN issues them on the partner portal for live use).
Parse.Cloud.define('adminMtnSandboxUser', async (request) => {
  const actor = await requireAdminUnlock(request);
  const row = await secretRow();
  const all = row?.get('value') || {};
  const own = all.mtn || {};
  if ((own.environment || 'sandbox') !== 'sandbox')
    throw invalid('Only for the MTN test (sandbox) environment');
  if (!own.subscriptionKey) throw invalid('Save the MTN subscription key first');
  let created;
  try {
    created = await api.mtnSandboxUser(own.subscriptionKey);
  } catch (error) {
    throw invalid(`MTN refused: ${errorMessage(error)}`);
  }
  all.mtn = { ...own, ...created };
  delete all.mtn.lastTest;
  row.set('value', all);
  await row.save(null, MASTER);
  await audit(actor, 'payment.settings_saved', { className: 'Secret', id: 'mtn' }, null, {
    provider: 'mtn',
    sandboxUserCreated: true,
  });
  return { apiUser: mask(created.apiUser), apiKey: mask(created.apiKey) };
});

// ---- Requests to pay ----

async function settle(order, received, reason, transactionId) {
  const { settlePayment } = require('./payments');
  if (received && transactionId) order.set('paymentReference', transactionId.slice(0, 40));
  order.set({
    payRequestStatus: received ? 'successful' : 'failed',
    payRequestError: received ? '' : reason,
    paymentAuto: true,
  });
  await settlePayment(order, { received, reason, actor: null });
}

// Sends the queued request for an order. Safe to call more than once: only
// the first call for a request id sends anything.
async function sendRequest(order) {
  const id = order.get('payRequestId');
  if (order.get('payRequestStatus') !== 'queued' || !id) return;
  if (!(await claimOnce(`collect:${id}`))) return;
  const provider = order.get('paymentProvider');
  const [{ values: config }, keys] = await Promise.all([loadConfig(), loadKeys()]);
  const own = keys[provider] || {};
  const fail = (reason) => settle(order, false, reason);
  if (
    !PROVIDERS[provider] ||
    config[PROVIDERS[provider].toggle] !== true ||
    !configured(provider, own)
  )
    return fail('Automatic payments are switched off. Type the transaction ID instead');
  const msisdn = api.payerNumber(
    provider,
    order.get('payRequestPhone') || order.get('customerPhone'),
    config.momoDialCode || '256',
  );
  if (!msisdn) return fail('No usable phone number for the payment request');
  if (provider === 'mtn' && api.isMtnTestNumber(msisdn) && own.environment === 'production')
    return fail('MTN test numbers only work in the MTN test environment');
  const request = {
    amount: Number(order.get('total') || 0),
    currency: config.currencyCode,
    msisdn,
    externalId: order.get('orderCode'),
    note: `${config.restaurantName} ${order.get('orderCode')}`.slice(0, 60),
  };
  try {
    if (provider === 'mtn') await api.mtnRequest(own, { ...request, id });
    else await api.airtelRequest(own, { ...request, id: id.replace(/-/g, '') });
  } catch (error) {
    log('warn', 'payment.request_failed', {
      order: order.id,
      provider,
      message: errorMessage(error),
    });
    return fail(`The payment request could not be sent (${errorMessage(error)})`);
  }
  order.set({ payRequestStatus: 'pending', payRequestSentAt: new Date(), payRequestError: '' });
  await order.save(null, MASTER);
}

// Several screens may ask at once; the provider is asked at most every 3 s.
const lastPoll = new Map();

// Asks the provider how a sent request stands and settles it when it is
// done. Returns the order's payment state.
async function pollRequest(order) {
  if (order.get('payRequestStatus') === 'pending') {
    // Settled another way meanwhile (the cashier confirmed it by hand).
    if (order.get('paymentStatus') !== 'PENDING_VERIFICATION') {
      order.set('payRequestStatus', 'closed');
      await order.save(null, MASTER);
    } else if (Date.now() - (lastPoll.get(order.id) || 0) > 3000) {
      lastPoll.set(order.id, Date.now());
      if (lastPoll.size > 2000) lastPoll.clear();
      const provider = order.get('paymentProvider');
      const [{ values: config }, keys] = await Promise.all([loadConfig(), loadKeys()]);
      const id = order.get('payRequestId');
      let result = null;
      try {
        result =
          provider === 'mtn'
            ? await api.mtnStatus(keys.mtn, id)
            : await api.airtelStatus(keys.airtel, id.replace(/-/g, ''), config.currencyCode);
      } catch (error) {
        log('warn', 'payment.status_failed', { order: order.id, message: errorMessage(error) });
      }
      const sent = order.get('payRequestSentAt') || order.get('payRequestAt') || new Date();
      if (result?.status === 'successful') await settle(order, true, '', result.transactionId);
      else if (result?.status === 'failed')
        await settle(
          order,
          false,
          result.reason
            ? `The customer’s payment did not go through (${result.reason})`
            : 'The customer declined or did not complete the payment',
        );
      else if (Date.now() - sent > EXPIRE_MINUTES * 60000)
        await settle(order, false, 'The customer did not approve the payment in time');
    }
  }
  return {
    payRequestStatus: order.get('payRequestStatus') || '',
    paymentStatus: order.get('paymentStatus') || '',
    reason: order.get('payRequestError') || order.get('paymentRejectReason') || '',
    reference: order.get('paymentReference') || '',
  };
}

// Queued requests are sent as soon as the order is saved.
Parse.Cloud.afterSave('Order', async (request) => {
  if (request.object.get('payRequestStatus') !== 'queued') return;
  try {
    // Relay Hosted: triggers run outside the request; work as the order's restaurant.
    const tenant = request.object.get('tenant')?.id;
    await require('./lib/tenant').runAs(tenant, async () => {
      const order = await new Parse.Query('Order').get(request.object.id, MASTER);
      await sendRequest(order);
    });
  } catch (error) {
    log('error', 'payment.request_error', {
      order: request.object.id,
      message: errorMessage(error),
    });
  }
});

// The rider who took the order, or staff: how the payment request stands.
Parse.Cloud.define('checkPaymentRequest', async (request) => {
  const actor = requireUser(request);
  const id = String(request.params?.orderId || '');
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw invalid('Unknown order');
  const order = await new Parse.Query('Order').get(id, MASTER);
  const role = await getRoleName(actor);
  if (order.get('createdBy')?.id !== actor.id && !['cashier', 'admin'].includes(role))
    throw forbidden('Not allowed');
  if (order.get('payRequestStatus') === 'queued') await sendRequest(order);
  return pollRequest(order);
});

// Staff screens and every app's notification check: bring open requests up
// to date (a few at a time, at most every 5 seconds per server).
let lastSweep = 0;
async function sweepRequests(limit = 10) {
  if (Date.now() - lastSweep < 5000) return 0;
  lastSweep = Date.now();
  const query = new Parse.Query('Order');
  query.containedIn('payRequestStatus', ['queued', 'pending']);
  query.ascending('updatedAt');
  query.limit(limit);
  const open = await query.find(MASTER).catch(() => []);
  for (const order of open) {
    try {
      if (order.get('payRequestStatus') === 'queued') await sendRequest(order);
      else await pollRequest(order);
    } catch (error) {
      log('warn', 'payment.sweep_failed', { order: order.id, message: errorMessage(error) });
    }
  }
  return open.length;
}

// Used by payments.js: a new request id for an order being paid automatically.
const newRequest = (payerPhone) => ({
  payRequestStatus: 'queued',
  payRequestId: crypto.randomUUID(),
  payRequestPhone: String(payerPhone || ''),
  payRequestAt: new Date(),
  payRequestError: '',
});

module.exports = { newRequest, sweepRequests, pollRequest, PROVIDERS };
