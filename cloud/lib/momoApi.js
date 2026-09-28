// Mobile money collection APIs: MTN MoMo (Collection product, momodeveloper
// .mtn.com) and Airtel Money (Collection / USSD push, developers.airtel.africa).
// Each asks the customer's phone to approve a payment to the restaurant and
// reports whether it went through. The owner's API keys come from
// cloud/collections.js; nothing here is stored.
//
// MTN:    POST /collection/token/                 (Basic apiUser:apiKey)
//         POST /collection/v1_0/requesttopay      (X-Reference-Id = our id)
//         GET  /collection/v1_0/requesttopay/{id} → PENDING | SUCCESSFUL | FAILED
//         Sandbox only: POST /v1_0/apiuser, POST /v1_0/apiuser/{id}/apikey
// Airtel: POST /auth/oauth2/token                 (client credentials)
//         POST /merchant/v1/payments/             (USSD push)
//         GET  /standard/v1/payments/{id}         → TS | TF | TA | TIP | TE

const crypto = require('crypto');

const MTN_URLS = {
  sandbox: 'https://sandbox.momodeveloper.mtn.com',
  production: 'https://proxy.momoapi.mtn.com',
};
const AIRTEL_URLS = {
  sandbox: 'https://openapiuat.airtel.africa',
  production: 'https://openapi.airtel.africa',
};
// Tests point these at a local stand-in (RELAY_MTN_URL / RELAY_AIRTEL_URL).
const mtnBase = (settings) =>
  process.env.RELAY_MTN_URL || MTN_URLS[settings.environment] || MTN_URLS.sandbox;
const airtelBase = (settings) =>
  process.env.RELAY_AIRTEL_URL || AIRTEL_URLS[settings.environment] || AIRTEL_URLS.sandbox;

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, url, { headers = {}, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new ProviderError(`Could not reach the provider (${error.message})`, 0);
  }
  const text = await response.text();
  const data = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { raw: text.slice(0, 300) };
    }
  })();
  if (!response.ok) {
    const detail =
      data?.message || data?.error_description || data?.error || data?.status?.message || text;
    throw new ProviderError(
      `${response.status} ${String(detail || response.statusText).slice(0, 200)}`,
      response.status,
    );
  }
  return { status: response.status, data };
}

// Access tokens are reused until a minute before they expire.
const tokens = new Map();
async function cachedToken(key, fetchToken) {
  const hit = tokens.get(key);
  if (hit && hit.expires > Date.now()) return hit.token;
  const { token, seconds } = await fetchToken();
  tokens.set(key, { token, expires: Date.now() + Math.max(60, seconds - 60) * 1000 });
  return token;
}
const forget = (key) => tokens.delete(key);

// ---- MTN MoMo ----

const mtnHeaders = (settings) => ({ 'Ocp-Apim-Subscription-Key': settings.subscriptionKey });
const mtnKey = (settings) => `mtn:${settings.environment}:${settings.apiUser}`;

function mtnToken(settings) {
  return cachedToken(mtnKey(settings), async () => {
    const basic = Buffer.from(`${settings.apiUser}:${settings.apiKey}`).toString('base64');
    const { data } = await call('POST', `${mtnBase(settings)}/collection/token/`, {
      headers: { ...mtnHeaders(settings), Authorization: `Basic ${basic}` },
    });
    if (!data?.access_token) throw new ProviderError('MTN did not return an access token', 0);
    return { token: data.access_token, seconds: Number(data.expires_in) || 3600 };
  });
}

const mtnTarget = (settings) =>
  settings.environment === 'production' ? settings.targetEnvironment || 'mtnuganda' : 'sandbox';

async function mtnRequest(settings, { id, amount, currency, msisdn, externalId, note }) {
  const token = await mtnToken(settings);
  await call('POST', `${mtnBase(settings)}/collection/v1_0/requesttopay`, {
    headers: {
      ...mtnHeaders(settings),
      Authorization: `Bearer ${token}`,
      'X-Reference-Id': id,
      'X-Target-Environment': mtnTarget(settings),
      'Content-Type': 'application/json',
    },
    body: {
      amount: String(Math.round(amount)),
      // The sandbox only accepts EUR.
      currency: settings.environment === 'production' ? currency : 'EUR',
      externalId,
      payer: { partyIdType: 'MSISDN', partyId: msisdn },
      payerMessage: note,
      payeeNote: note,
    },
  });
}

async function mtnStatus(settings, id) {
  const token = await mtnToken(settings);
  const { data } = await call('GET', `${mtnBase(settings)}/collection/v1_0/requesttopay/${id}`, {
    headers: {
      ...mtnHeaders(settings),
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': mtnTarget(settings),
    },
  });
  const status = String(data?.status || '').toUpperCase();
  const reason =
    typeof data?.reason === 'string' ? data.reason : data?.reason?.message || data?.reason?.code;
  return {
    status: status === 'SUCCESSFUL' ? 'successful' : status === 'FAILED' ? 'failed' : 'pending',
    transactionId: String(data?.financialTransactionId || ''),
    reason: reason ? String(reason) : '',
  };
}

// Sandbox only: MTN's sandbox makes its own API user and key from the
// subscription key (in production MTN issues them on the partner portal).
async function mtnSandboxUser(subscriptionKey, callbackHost = 'example.com') {
  const settings = { environment: 'sandbox', subscriptionKey };
  const apiUser = crypto.randomUUID();
  await call('POST', `${mtnBase(settings)}/v1_0/apiuser`, {
    headers: {
      ...mtnHeaders(settings),
      'X-Reference-Id': apiUser,
      'Content-Type': 'application/json',
    },
    body: { providerCallbackHost: callbackHost },
  });
  const { data } = await call('POST', `${mtnBase(settings)}/v1_0/apiuser/${apiUser}/apikey`, {
    headers: mtnHeaders(settings),
  });
  if (!data?.apiKey) throw new ProviderError('MTN did not return an API key', 0);
  return { apiUser, apiKey: data.apiKey };
}

// ---- Airtel Money ----

const airtelKey = (settings) => `airtel:${settings.environment}:${settings.clientId}`;

function airtelToken(settings) {
  return cachedToken(airtelKey(settings), async () => {
    const { data } = await call('POST', `${airtelBase(settings)}/auth/oauth2/token`, {
      headers: { 'Content-Type': 'application/json' },
      body: {
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        grant_type: 'client_credentials',
      },
    });
    if (!data?.access_token) throw new ProviderError('Airtel did not return an access token', 0);
    return { token: data.access_token, seconds: Number(data.expires_in) || 180 };
  });
}

const airtelHeaders = (settings, token, currency) => ({
  Authorization: `Bearer ${token}`,
  'X-Country': settings.country || 'UG',
  'X-Currency': currency,
  'Content-Type': 'application/json',
});

async function airtelRequest(settings, { id, amount, currency, msisdn, externalId }) {
  const token = await airtelToken(settings);
  const country = settings.country || 'UG';
  const { data } = await call('POST', `${airtelBase(settings)}/merchant/v1/payments/`, {
    headers: airtelHeaders(settings, token, currency),
    body: {
      reference: externalId,
      subscriber: { country, currency, msisdn },
      transaction: { amount: Math.round(amount), country, currency, id },
    },
  });
  if (data?.status && data.status.success === false)
    throw new ProviderError(data.status.message || 'Airtel refused the request', 0);
}

async function airtelStatus(settings, id, currency) {
  const token = await airtelToken(settings);
  const { data } = await call('GET', `${airtelBase(settings)}/standard/v1/payments/${id}`, {
    headers: airtelHeaders(settings, token, currency),
  });
  const transaction = data?.data?.transaction || {};
  const code = String(transaction.status || '').toUpperCase();
  return {
    status: code === 'TS' ? 'successful' : code === 'TF' || code === 'TE' ? 'failed' : 'pending',
    transactionId: String(transaction.airtel_money_id || ''),
    reason: code === 'TS' ? '' : String(transaction.message || ''),
  };
}

// The number each provider wants: MTN takes the full international number
// (256772123456), Airtel the national number without the leading 0
// (752123456). `dial` is the country code without "+". '' if unusable.
function payerNumber(provider, phone, dial = '256') {
  let digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith(dial)) digits = digits.slice(dial.length);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 8 || digits.length > 10) return '';
  return provider === 'mtn' ? `${dial}${digits}` : digits;
}

module.exports = {
  ProviderError,
  mtnToken,
  mtnRequest,
  mtnStatus,
  mtnSandboxUser,
  airtelToken,
  airtelRequest,
  airtelStatus,
  payerNumber,
  forgetToken: forget,
  mtnKey,
  airtelKey,
};
