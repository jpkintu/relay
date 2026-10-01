// Relay Hosted: the Zoho Books API (https://www.zoho.com/books/api/v3/) for
// the platform's own books (platformAccounting.js). Platform staff connect
// with a Zoho "Self Client": its client ID and secret and a one-time grant
// code, exchanged here for a refresh token. RELAY_ZOHO_ACCOUNTS_URL and
// RELAY_ZOHO_API_URL point the calls elsewhere (the e2e stand-in).

// Zoho data centres: the domain of the accounts and API servers.
const DATA_CENTRES = {
  com: 'United States (zoho.com)',
  eu: 'Europe (zoho.eu)',
  in: 'India (zoho.in)',
  'com.au': 'Australia (zoho.com.au)',
  jp: 'Japan (zoho.jp)',
  ca: 'Canada (zohocloud.ca)',
  sa: 'Saudi Arabia (zoho.sa)',
  uk: 'United Kingdom (zoho.uk)',
};
const accountsUrl = (dc) =>
  process.env.RELAY_ZOHO_ACCOUNTS_URL ||
  (dc === 'ca' ? 'https://accounts.zohocloud.ca' : `https://accounts.zoho.${dc}`);
const apiUrl = (dc) =>
  process.env.RELAY_ZOHO_API_URL ||
  (dc === 'ca' ? 'https://www.zohoapis.ca/books/v3' : `https://www.zohoapis.${dc}/books/v3`);

async function tokenRequest(dc, params) {
  const response = await fetch(`${accountsUrl(dc)}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error || !json.access_token)
    throw new Error(
      json.error === 'invalid_code'
        ? 'The grant code is wrong or has expired: make a new one'
        : json.error || `Zoho answered ${response.status}`,
    );
  return json;
}

// The one-time grant code → { refreshToken, accessToken, expiresAt }.
async function exchangeGrant({ dc, clientId, clientSecret, grantCode }) {
  const json = await tokenRequest(dc, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: grantCode,
  });
  if (!json.refresh_token) throw new Error('Zoho gave no refresh token: make a new grant code');
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60000,
  };
}

// A client for one connection ({ dc, orgId, clientId, clientSecret,
// refreshToken, accessToken?, expiresAt? }). `onToken` saves a new access
// token.
function client(settings, onToken = async () => undefined) {
  let token = settings.accessToken;
  let expiresAt = Number(settings.expiresAt) || 0;
  async function accessToken() {
    if (token && expiresAt > Date.now()) return token;
    const json = await tokenRequest(settings.dc, {
      grant_type: 'refresh_token',
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      refresh_token: settings.refreshToken,
    });
    token = json.access_token;
    expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60000;
    await onToken({ accessToken: token, expiresAt });
    return token;
  }
  async function call(method, path, { query = {}, body } = {}) {
    const url = new URL(`${apiUrl(settings.dc)}${path}`);
    url.searchParams.set('organization_id', settings.orgId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${await accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const json = await response.json().catch(() => ({}));
    // Zoho answers code 0 when it worked.
    if (!response.ok || (json.code !== undefined && json.code !== 0))
      throw new Error(json.message || `Zoho Books answered ${response.status}`);
    return json;
  }
  async function remove(path) {
    try {
      await call('DELETE', path);
      return true;
    } catch (error) {
      if (/not (be )?found|does not exist|no longer exists/i.test(String(error?.message)))
        return false;
      throw error;
    }
  }
  return {
    call,
    organization: () => call('GET', '/organizations/' + settings.orgId),
    accounts: async () => (await call('GET', '/chartofaccounts')).chartofaccounts || [],
    findContact: async (name) =>
      ((await call('GET', '/contacts', { query: { contact_name: name } })).contacts || [])[0] ||
      null,
    createContact: async (contact) => (await call('POST', '/contacts', { body: contact })).contact,
    createInvoice: async (invoice) =>
      (
        await call('POST', '/invoices', {
          query: { ignore_auto_number_generation: true },
          body: invoice,
        })
      ).invoice,
    markSent: (invoiceId) => call('POST', `/invoices/${invoiceId}/status/sent`),
    createPayment: async (payment) =>
      (await call('POST', '/customerpayments', { body: payment })).payment,
    createJournal: async (journal) => (await call('POST', '/journals', { body: journal })).journal,
    // Deleting (purge.js). Something already gone in Zoho counts as deleted.
    deletePayment: (id) => remove(`/customerpayments/${id}`),
    deleteInvoice: (id) => remove(`/invoices/${id}`),
    deleteContact: (id) => remove(`/contacts/${id}`),
    deleteJournal: (id) => remove(`/journals/${id}`),
  };
}

module.exports = { DATA_CENTRES, exchangeGrant, client };
