// Relay Hosted: the platform's own accounting (platform console →
// Accounting). Subscription money is received when paid but earned over the
// period it pays for (lib/earnings.js): a year paid in October is 1/12 earned
// in October; the rest is a prepayment (unearned revenue).
//
// For each month: money received, revenue earned (from that month's payments
// and from earlier prepayments), the prepayment balance at its end, and the
// invoices, to export (CSV, printed invoices) and to send to Zoho Books:
// - every paid payment becomes a Zoho invoice (to the prepayments account)
//   and a customer payment against it;
// - every closed month gets one journal moving what was earned from
//   prepayments to subscription revenue.
// Platform staff connect Zoho and choose the three accounts; with automatic
// sync on, payments go to Zoho as they are received and each month's journal
// is posted once the month is over (billing job, or the console).

const { MASTER, invalid, audit, claimOnce } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { requirePlatform, platformSettings } = require('./restaurants');
const { monthEarnings } = require('./lib/earnings');
const { isoDay, startOfDay } = require('./lib/dates');
const zoho = require('./lib/zoho');
const { log, errorMessage } = require('./lib/log');

const TIME_ZONE = process.env.RELAY_EMAIL_TZ || 'Africa/Kampala';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthOf = (date) => isoDay(date, TIME_ZONE).slice(0, 7);
const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
// [from, to) of a 'YYYY-MM' month in Kampala time.
const bounds = (month) => [
  startOfDay(`${month}-01`, TIME_ZONE).getTime(),
  startOfDay(`${nextMonth(month)}-01`, TIME_ZONE).getTime(),
];
const lastDay = (month) => isoDay(new Date(bounds(month)[1] - 1), TIME_ZONE);

// ---------------------------------------------------------------------------
// Settings (PlatformSettings.zoho, master key only)

async function loadZoho() {
  const row = await tenancy.withoutTenant(() => new Parse.Query('PlatformSettings').first(MASTER));
  return { row, zoho: { ...(row?.get('zoho') || {}) } };
}
async function saveZoho(row, next) {
  row.set('zoho', next);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
}
const connected = (z) => !!(z.refreshToken && z.orgId && z.clientId && z.clientSecret);
const ready = (z) =>
  connected(z) && !!(z.accounts?.deferred && z.accounts?.revenue && z.accounts?.deposit);

function zohoView(z) {
  return {
    connected: connected(z),
    ready: ready(z),
    dc: z.dc || 'com',
    orgId: z.orgId || '',
    orgName: z.orgName || '',
    clientId: z.clientId || '',
    secretSet: !!z.clientSecret,
    accounts: z.accounts || {},
    accountNames: z.accountNames || {},
    autoSync: z.autoSync === true,
    // Payments before this month stay out of Zoho (opening balances are
    // entered there by hand).
    fromMonth: z.fromMonth || '',
    connectedAt: z.connectedAt || null,
    dataCentres: zoho.DATA_CENTRES,
  };
}

async function zohoClient() {
  const { row, zoho: z } = await loadZoho();
  if (!connected(z)) throw invalid('Connect Zoho Books first');
  return {
    z,
    api: zoho.client(z, async (token) => saveZoho(row, { ...(await loadZoho()).zoho, ...token })),
  };
}

// ---------------------------------------------------------------------------
// The month's figures

// Paid payments up to `to`, as plain rows with their restaurant.
async function paidPayments(to) {
  const query = new Parse.Query('SubscriptionPayment');
  query.equalTo('status', 'paid');
  query.include('tenant');
  const rows = await tenancy.withoutTenant(() => query.findAll({ ...MASTER, batchSize: 1000 }));
  const { values: platform } = await platformSettings();
  const planName = Object.fromEntries((platform.plans || []).map((p) => [p.key, p.name]));
  return rows
    .map((p) => {
      const r = p.get('tenant');
      const paidAt = p.get('paidAt') || p.createdAt;
      return {
        id: p.id,
        number: `INV-${String(r?.get('code') || '').toUpperCase()}-${p.id}`,
        amount: Number(p.get('amount')) || 0,
        currency: p.get('currency') || platform.currency,
        paidAt: paidAt.toISOString(),
        periodStart: p.get('periodStart')?.toISOString() || null,
        periodEnd: p.get('periodEnd')?.toISOString() || null,
        months: Number(p.get('months')) || 0,
        kind: p.get('kind') || 'period',
        planName: planName[p.get('plan')] || '',
        method: p.get('method') || 'iotec',
        payer: p.get('payer') || '',
        reference: p.get('reference') || '',
        listAmount: p.get('listAmount') ?? null,
        discount: p.get('discount') || 0,
        discountCode: p.get('discountCode') || '',
        restaurantId: r?.id || '',
        restaurant: r?.get('name') || '',
        code: r?.get('code') || '',
        ownerName: r?.get('ownerName') || '',
        ownerEmail: r?.get('ownerEmail') || '',
        billingPhone: r?.get('billingPhone') || '',
        zohoInvoiceId: p.get('zohoInvoiceId') || '',
        zohoPaymentId: p.get('zohoPaymentId') || '',
        zohoError: p.get('zohoError') || '',
      };
    })
    .filter((p) => new Date(p.paidAt).getTime() < to);
}

async function postingOf(month) {
  return tenancy.withoutTenant(() =>
    new Parse.Query('AccountingPosting').equalTo('month', month).first(MASTER),
  );
}

// Platform: { month: 'YYYY-MM' } → the month's earnings and invoices.
Parse.Cloud.define('platformGetAccounting', async (request) => {
  await requirePlatform(request);
  const month = MONTH.test(String(request.params?.month || ''))
    ? String(request.params.month)
    : monthOf(new Date());
  const [from, to] = bounds(month);
  const { values: platform } = await platformSettings();
  const { totals, rows } = monthEarnings(await paidPayments(to), from, to);
  const posting = await postingOf(month);
  const { zoho: z } = await loadZoho();
  return {
    month,
    currency: platform.currency,
    closed: to <= Date.now(),
    totals,
    rows,
    billingFrom: platform.billingFrom || '',
    supportContact: platform.supportContact || '',
    posting: posting
      ? {
          amount: posting.get('amount'),
          zohoJournalId: posting.get('zohoJournalId') || '',
          postedAt: posting.get('postedAt')?.toISOString() || null,
          by: posting.get('byName') || '',
        }
      : null,
    zoho: zohoView(z),
  };
});

// ---------------------------------------------------------------------------
// Zoho Books: connection

Parse.Cloud.define('platformGetZoho', async (request) => {
  await requirePlatform(request);
  const { zoho: z } = await loadZoho();
  const view = zohoView(z);
  if (!connected(z)) return { ...view, chart: [] };
  // The accounts to choose from: liabilities (prepayments), income, and
  // bank or cash (where the money lands).
  try {
    const { api } = await zohoClient();
    const chart = (await api.accounts())
      .filter((a) => a.is_active !== false)
      .map((a) => ({ id: a.account_id, name: a.account_name, type: a.account_type }));
    return { ...view, chart };
  } catch (error) {
    return { ...view, chart: [], error: errorMessage(error) };
  }
});

// { dc, orgId, clientId, clientSecret, grantCode }: the Self Client's details
// and a fresh grant code (scope ZohoBooks.fullaccess.all).
Parse.Cloud.define('platformConnectZoho', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const { row, zoho: before } = await loadZoho();
  if (!row) throw invalid('Save the platform settings first');
  const dc = String(p.dc || before.dc || 'com');
  if (!zoho.DATA_CENTRES[dc]) throw invalid('Choose the Zoho data centre of your account');
  const orgId = String(p.orgId || '').trim();
  const clientId = String(p.clientId || before.clientId || '').trim();
  const clientSecret = String(p.clientSecret || before.clientSecret || '').trim();
  const grantCode = String(p.grantCode || '').trim();
  if (!/^\d{5,20}$/.test(orgId))
    throw invalid('Organization ID: the number in Zoho Books → Settings → Organization profile');
  if (!clientId || !clientSecret)
    throw invalid('Enter the client ID and client secret of the Self Client');
  if (!grantCode) throw invalid('Generate a grant code in the Self Client and paste it');
  let tokens;
  try {
    tokens = await zoho.exchangeGrant({ dc, clientId, clientSecret, grantCode });
  } catch (error) {
    throw invalid(`Zoho refused: ${errorMessage(error)}`);
  }
  const next = {
    ...before,
    dc,
    orgId,
    clientId,
    clientSecret,
    ...tokens,
    connectedAt: new Date().toISOString(),
    fromMonth: before.fromMonth || monthOf(new Date()),
  };
  // Check the organization answers.
  try {
    const org = await zoho.client(next).organization();
    next.orgName = org?.organization?.name || '';
  } catch (error) {
    throw invalid(`Connected, but the organization did not answer: ${errorMessage(error)}`);
  }
  await saveZoho(row, next);
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.zoho_connected', row, null, { orgId, orgName: next.orgName, dc }),
  );
  return zohoView(next);
});

// { accounts: { deferred, revenue, deposit }, accountNames, autoSync, fromMonth }
Parse.Cloud.define('platformSaveZoho', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const { row, zoho: z } = await loadZoho();
  if (!connected(z)) throw invalid('Connect Zoho Books first');
  const accounts = { ...(z.accounts || {}) };
  const names = { ...(z.accountNames || {}) };
  for (const key of ['deferred', 'revenue', 'deposit']) {
    if (p.accounts?.[key] === undefined) continue;
    accounts[key] = String(p.accounts[key] || '').slice(0, 40);
    names[key] = String(p.accountNames?.[key] || '').slice(0, 100);
  }
  const fromMonth = p.fromMonth === undefined ? z.fromMonth : String(p.fromMonth);
  if (fromMonth && !MONTH.test(fromMonth)) throw invalid('Start month: YYYY-MM');
  const next = {
    ...z,
    accounts,
    accountNames: names,
    autoSync: p.autoSync === undefined ? z.autoSync === true : p.autoSync === true,
    fromMonth,
  };
  await saveZoho(row, next);
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.zoho_saved', row, null, {
      accounts: names,
      autoSync: next.autoSync,
      fromMonth,
    }),
  );
  return zohoView(next);
});

Parse.Cloud.define('platformDisconnectZoho', async (request) => {
  const actor = await requirePlatform(request);
  const { row, zoho: z } = await loadZoho();
  if (!row) return zohoView({});
  const next = { dc: z.dc, orgId: z.orgId, clientId: z.clientId };
  await saveZoho(row, next);
  await tenancy.withoutTenant(() => audit(actor, 'platform.zoho_disconnected', row, null, {}));
  return zohoView(next);
});

// ---------------------------------------------------------------------------
// Zoho Books: invoices, payments and the month's journal

const dayOf = (iso) => isoDay(new Date(iso), TIME_ZONE);
const money = (n, currency) => `${currency} ${Math.round(n).toLocaleString('en-US')}`;

async function contactFor(api, restaurantId) {
  const r = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(restaurantId, MASTER),
  );
  if (r.get('zohoContactId')) return r.get('zohoContactId');
  const name = `${r.get('name')} (${r.get('code')})`;
  let contact = await api.findContact(name);
  if (!contact)
    contact = await api.createContact({
      contact_name: name,
      company_name: r.get('name'),
      contact_type: 'customer',
      contact_persons: [
        {
          first_name: r.get('ownerName') || r.get('name'),
          email: r.get('ownerEmail') || undefined,
          phone: r.get('billingPhone') || undefined,
          is_primary_contact: true,
        },
      ],
    });
  r.set('zohoContactId', contact.contact_id);
  await tenancy.withoutTenant(() => r.save(null, MASTER));
  return contact.contact_id;
}

// One paid payment → a Zoho invoice to prepayments, marked sent, and a
// customer payment against it. Picks up where a failed attempt stopped.
async function syncPayment(api, z, row) {
  const payment = await tenancy.withoutTenant(() =>
    new Parse.Query('SubscriptionPayment').get(row.id, MASTER),
  );
  if (payment.get('zohoPaymentId') || !(row.amount > 0)) return false;
  try {
    const customerId = await contactFor(api, row.restaurantId);
    let invoiceId = payment.get('zohoInvoiceId');
    if (!invoiceId) {
      const period =
        row.periodStart && row.periodEnd
          ? `${dayOf(row.periodStart)} to ${dayOf(row.periodEnd)}`
          : '';
      const invoice = await api.createInvoice({
        customer_id: customerId,
        invoice_number: row.number,
        reference_number: row.id,
        date: dayOf(row.paidAt),
        due_date: dayOf(row.paidAt),
        line_items: [
          {
            name: `Relay ${row.planName || 'subscription'}${row.kind === 'upgrade' ? ' upgrade' : ''}`,
            description: [
              row.kind === 'upgrade'
                ? 'Upgrade for the days left'
                : row.months === 12
                  ? '1 year'
                  : `${row.months} month${row.months === 1 ? '' : 's'}`,
              period,
              row.discount ? `less ${money(row.discount, row.currency)} (${row.discountCode})` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            rate: row.amount,
            quantity: 1,
            account_id: z.accounts.deferred,
          },
        ],
        notes: 'Relay subscription, paid in advance: earned over the period.',
      });
      invoiceId = invoice.invoice_id;
      payment.set('zohoInvoiceId', invoiceId);
      await payment.save(null, MASTER);
      await api.markSent(invoiceId);
    }
    const paid = await api.createPayment({
      customer_id: customerId,
      payment_mode: row.method === 'manual' ? 'Cash' : 'Mobile Money',
      amount: row.amount,
      date: dayOf(row.paidAt),
      reference_number: row.reference || row.id,
      account_id: z.accounts.deposit,
      invoices: [{ invoice_id: invoiceId, amount_applied: row.amount }],
      description: `${row.number}${row.payer ? ` from ${row.payer}` : ''}`,
    });
    payment.set({ zohoPaymentId: paid.payment_id, zohoSyncedAt: new Date() });
    payment.unset('zohoError');
    await payment.save(null, MASTER);
    return true;
  } catch (error) {
    payment.set('zohoError', errorMessage(error).slice(0, 300));
    await payment.save(null, MASTER);
    throw error;
  }
}

// The month's paid payments (from the start month on) into Zoho.
async function syncMonth(month) {
  const { z, api } = await zohoClient();
  if (!ready(z)) throw invalid('Choose the three Zoho accounts first');
  if (z.fromMonth && month < z.fromMonth)
    throw invalid(`Zoho sync starts with ${z.fromMonth}; earlier months stay out`);
  const [from, to] = bounds(month);
  const rows = (await paidPayments(to)).filter((p) => new Date(p.paidAt).getTime() >= from);
  let synced = 0;
  const errors = [];
  for (const row of rows) {
    try {
      if (await syncPayment(api, z, row)) synced += 1;
    } catch (error) {
      errors.push(`${row.number}: ${errorMessage(error)}`);
    }
  }
  return { synced, already: rows.length - synced - errors.length, errors };
}

// The journal moving the month's earnings from prepayments to revenue; once
// per month, for a month that is over.
async function postMonth(month, actorName) {
  const { z, api } = await zohoClient();
  if (!ready(z)) throw invalid('Choose the three Zoho accounts first');
  if (z.fromMonth && month < z.fromMonth)
    throw invalid(`Zoho sync starts with ${z.fromMonth}; earlier months stay out`);
  const [from, to] = bounds(month);
  if (to > Date.now()) throw invalid('Post a month once it is over');
  if (await postingOf(month)) throw invalid(`${month} is already posted`);
  // Two posts at the same moment: only one goes on (a failed one may retry
  // a minute later).
  const minute = Math.floor(Date.now() / 60000);
  if (!(await tenancy.withoutTenant(() => claimOnce(`zoho-journal:${month}:${minute}`))))
    throw invalid(`${month} is being posted`);
  // Only payments that are in Zoho count (from the start month on).
  const startFrom = z.fromMonth ? bounds(z.fromMonth)[0] : -Infinity;
  const payments = (await paidPayments(to)).filter(
    (p) => new Date(p.paidAt).getTime() >= startFrom,
  );
  const { totals, rows } = monthEarnings(payments, from, to);
  const posting = new Parse.Object('AccountingPosting');
  posting.set({ month, amount: totals.earned, invoices: rows.length, byName: actorName });
  posting.setACL(new Parse.ACL());
  if (totals.earned > 0) {
    const journal = await api.createJournal({
      journal_date: lastDay(month),
      reference_number: `RELAY-EARNED-${month}`,
      notes: `Relay subscriptions earned in ${month} (${rows.length} invoices): unearned revenue released.`,
      line_items: [
        {
          account_id: z.accounts.deferred,
          debit_or_credit: 'debit',
          amount: totals.earned,
          description: 'Prepaid subscriptions earned this month',
        },
        {
          account_id: z.accounts.revenue,
          debit_or_credit: 'credit',
          amount: totals.earned,
          description: 'Subscription revenue',
        },
      ],
    });
    posting.set('zohoJournalId', journal.journal_id);
  }
  posting.set('postedAt', new Date());
  await tenancy.withoutTenant(() => posting.save(null, MASTER));
  return { month, amount: totals.earned, zohoJournalId: posting.get('zohoJournalId') || '' };
}

// Platform: { month } → the month's payments into Zoho Books.
Parse.Cloud.define('platformSyncZoho', async (request) => {
  const actor = await requirePlatform(request);
  const month = String(request.params?.month || '');
  if (!MONTH.test(month)) throw invalid('Choose a month');
  const result = await syncMonth(month);
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.zoho_synced', actor, null, { month, ...result }),
  );
  return result;
});

// Platform: { month } → the month's earnings journal in Zoho Books.
Parse.Cloud.define('platformPostEarnings', async (request) => {
  const actor = await requirePlatform(request);
  const month = String(request.params?.month || '');
  if (!MONTH.test(month)) throw invalid('Choose a month');
  await syncMonth(month);
  let result;
  try {
    result = await postMonth(month, actor.get('name') || actor.getUsername());
  } catch (error) {
    if (error instanceof Parse.Error) throw error;
    throw invalid(`Zoho refused: ${errorMessage(error)}`);
  }
  await tenancy.withoutTenant(() => audit(actor, 'platform.earnings_posted', actor, null, result));
  return result;
});

// Automatic sync (on): a payment just received goes to Zoho (billing.js →
// settle), and closed months are posted (billing job). Best effort.
async function autoSyncPayment(paymentId) {
  try {
    const { zoho: z } = await loadZoho();
    if (!ready(z) || z.autoSync !== true) return;
    const row = (await paidPayments(Date.now() + 1)).find((p) => p.id === paymentId);
    if (!row || (z.fromMonth && monthOf(new Date(row.paidAt)) < z.fromMonth)) return;
    const { api } = await zohoClient();
    await syncPayment(api, z, row);
  } catch (error) {
    log('warn', 'zoho.sync_failed', { payment: paymentId, message: errorMessage(error) });
  }
}

async function autoPostMonths() {
  try {
    const { zoho: z } = await loadZoho();
    if (!ready(z) || z.autoSync !== true || !z.fromMonth) return 0;
    let posted = 0;
    const current = monthOf(new Date());
    for (let month = z.fromMonth; month < current; month = nextMonth(month)) {
      if (await postingOf(month)) continue;
      await syncMonth(month);
      await postMonth(month, 'Automatic');
      posted += 1;
    }
    return posted;
  } catch (error) {
    log('warn', 'zoho.post_failed', { message: errorMessage(error) });
    return 0;
  }
}

module.exports = { autoSyncPayment, autoPostMonths, bounds, monthOf };
