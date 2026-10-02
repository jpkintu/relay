// Vouchers: money a customer paid for an order that was then cancelled. It
// is owed to them, and they choose how to get it back:
// - Spent on a new order (their own: the phone number must match). A
//   voucher is used whole: it pays as much of the order as it can and any
//   rest of the bill is paid in cash, mobile money or card; if the order
//   costs less, what is left stays theirs as a new voucher.
// - Refunded: sent back by mobile money, less the charges for sending it
//   (Admin → Accounting → Refunds sets them).
// Until spent or refunded, a voucher is a liability on the balance sheet
// (accounting.js).

const crypto = require('crypto');
const {
  MASTER,
  invalid,
  forbidden,
  requireRole,
  audit,
  loadConfig,
  findAll,
  claimOnce,
  personName,
} = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');

const CLASS = 'Voucher';
const CODE = /^V[A-Z0-9]{7}$/;
const ID = /^[A-Za-z0-9]{1,32}$/;
// Letters and digits that cannot be mistaken for one another.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const newCode = () =>
  `V${Array.from(crypto.randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');
const samePhone = (a, b) => {
  const x = digitsOf(a);
  const y = digitsOf(b);
  return x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9);
};
const round = (n) => Math.round(Number(n) || 0);

// What sending a refund back costs (mobile money charges), taken off it.
function refundCharge(config, amount) {
  const flat = Math.max(0, round(config.refundChargeFlat));
  const percent = Math.max(0, Number(config.refundChargePercent) || 0);
  return Math.min(round(amount), round(flat + (amount * percent) / 100));
}

const view = (row, config) => {
  const amount = round(row.get('amount'));
  const charges =
    row.get('status') === 'refunded'
      ? round(row.get('refundCharges'))
      : refundCharge(config, amount);
  return {
    id: row.id,
    code: row.get('code'),
    amount,
    phone: row.get('phone') || '',
    customerName: row.get('customerName') || '',
    status: row.get('status'),
    kind: row.get('kind') || 'payment',
    openedAt: row.get('openedAt')?.toISOString() || null,
    sourceOrder: row.get('sourceOrder')
      ? { id: row.get('sourceOrder').id, code: row.get('sourceCode') || '' }
      : null,
    fromVoucher: row.get('parentCode') || '',
    usedOn: row.get('usedOrder')
      ? { id: row.get('usedOrder').id, code: row.get('usedCode') || '' }
      : null,
    usedAt: row.get('usedAt')?.toISOString() || null,
    usedAmount: round(row.get('usedAmount')),
    // Refund: sent back less the charges.
    charges,
    toSend: amount - charges,
    refundedAt: row.get('refundedAt')?.toISOString() || null,
    refundNote: row.get('refundNote') || '',
  };
};

// The vouchers a cancelled order leaves (once each):
// - 'payment': its mobile money / card that came in (cash in, at
//   `paymentCheckedAt`, maybe after the cancel);
// - 'restore': a voucher it was paid with, given back.
// (Cash taken into a till is handed back at once and leaves none.)
const KINDS = ['payment', 'restore'];
function amountOf(order, kind) {
  if (kind === 'restore') return round(order.get('voucherAmount'));
  return order.get('paymentStatus') === 'VERIFIED' &&
    ['mobile_money', 'card'].includes(order.get('paymentMethod'))
    ? round(order.get('total'))
    : 0;
}
async function openForOrder(order, { refunded = false } = {}) {
  if (order.get('status') !== 'CANCELLED') return [];
  const made = [];
  for (const kind of KINDS) {
    const amount = amountOf(order, kind);
    if (amount <= 0) continue;
    const existing = await new Parse.Query(CLASS)
      .equalTo('sourceOrder', order)
      .equalTo('kind', kind)
      .first(MASTER);
    if (existing || !(await claimOnce(`voucher:${order.id}:${kind}`))) continue;
    const refundedAt = refunded && kind === 'payment' ? order.get('refundedAt') : null;
    const row = new Parse.Object(CLASS);
    row.set({
      code: newCode(),
      kind,
      amount,
      cashIn: kind === 'payment' ? amount : 0,
      phone: order.get('customerPhone') || order.get('payRequestPhone') || '',
      customerName: order.get('customerName') || '',
      status: refundedAt ? 'refunded' : 'open',
      sourceOrder: order,
      sourceCode: order.get('orderCode'),
      openedAt:
        (kind === 'payment' && order.get('paymentCheckedAt')) ||
        order.get('cancelledAt') ||
        new Date(),
      ...(order.get('branch') && { branch: order.get('branch') }),
      ...(refundedAt && {
        refundedAt,
        refundCharges: 0,
        refundSent: amount,
        refundNote: order.get('refundNote') || '',
      }),
    });
    row.setACL(new Parse.ACL());
    await row.save(null, MASTER);
    await audit(null, 'voucher.opened', row, null, {
      order: order.get('orderCode'),
      kind,
      amount,
      code: row.get('code'),
    });
    made.push(row);
  }
  return made;
}

// Cancelled orders paid before vouchers existed get theirs (also refunded
// ones, so the books keep them).
async function backfill() {
  const orders = await findAll(new Parse.Query('Order').equalTo('status', 'CANCELLED'));
  const due = orders.filter((o) => KINDS.some((kind) => amountOf(o, kind) > 0));
  if (!due.length) return;
  const have = new Set(
    (await findAll(new Parse.Query(CLASS).exists('sourceOrder'))).map(
      (row) => `${row.get('sourceOrder').id}:${row.get('kind') || 'payment'}`,
    ),
  );
  for (const order of due)
    if (KINDS.some((kind) => amountOf(order, kind) > 0 && !have.has(`${order.id}:${kind}`)))
      await openForOrder(order, { refunded: !!order.get('refundedAt') });
}

// An open voucher of this customer, by its code (nothing changed).
async function find(code, phone) {
  const value = String(code || '')
    .trim()
    .toUpperCase();
  if (!CODE.test(value)) throw invalid('That voucher code is not right');
  const row = await new Parse.Query(CLASS).equalTo('code', value).first(MASTER);
  if (!row) throw invalid('That voucher code is not right');
  if (row.get('status') !== 'open')
    throw invalid(
      row.get('status') === 'used'
        ? 'This voucher has been used'
        : 'This voucher was refunded to the customer',
    );
  if (!samePhone(row.get('phone'), phone))
    throw forbidden('This voucher belongs to another customer: use their phone number');
  return row;
}
// How much of a bill a voucher pays.
async function peek(code, phone, bill) {
  const row = await find(code, phone);
  return Math.min(round(row.get('amount')), round(bill));
}

// Spends a voucher on `order` (not saved yet; its total is the full bill).
// `phone`: the customer's number, which must be the voucher's. The order's
// `total` becomes what is still to pay; `voucherAmount` is what the voucher
// paid. Returns the voucher and any new voucher for what was left.
async function spend(order, code, phone, actor) {
  const row = await find(code, phone);
  const value = row.get('code');
  if (order.get('voucherAmount')) throw invalid('A voucher is already on this order');
  const amount = round(row.get('amount'));
  const bill = round(order.get('total'));
  const used = Math.min(amount, bill);
  const now = new Date();
  order.set({ voucherAmount: used, voucherCode: value, total: bill - used });
  row.set({ status: 'used', usedAt: now, usedAmount: used, usedCode: order.get('orderCode') });
  let rest = null;
  if (amount > used) {
    rest = new Parse.Object(CLASS);
    rest.set({
      code: newCode(),
      amount: amount - used,
      phone: row.get('phone'),
      customerName: row.get('customerName') || '',
      status: 'open',
      kind: 'rest',
      cashIn: 0,
      parent: row,
      parentCode: value,
      openedAt: now,
      ...(row.get('branch') && { branch: row.get('branch') }),
    });
    rest.setACL(new Parse.ACL());
  }
  return {
    voucher: row,
    rest,
    used,
    // Saved with the order (it needs the order's id).
    async save(saved) {
      // Spent meanwhile on another order (two tills at once): refuse.
      const fresh = await new Parse.Query(CLASS).get(row.id, MASTER);
      if (fresh.get('status') !== 'open') throw invalid('This voucher has been used');
      row.set('usedOrder', saved);
      await row.save(null, MASTER);
      if (rest) await rest.save(null, MASTER);
      await audit(
        actor || null,
        'voucher.used',
        row,
        { status: 'open' },
        {
          order: saved.get('orderCode'),
          used,
          left: rest ? round(rest.get('amount')) : 0,
          ...(rest && { newVoucher: rest.get('code') }),
        },
      );
    },
  };
}

// A bill fully paid by a voucher needs no other payment.
function paidByVoucher(order) {
  order.set({
    paymentMethod: 'voucher',
    paymentStatus: 'VERIFIED',
    cashStatus: 'NOT_APPLICABLE',
    amountToCollect: 0,
    billOpen: false,
    paidAt: new Date(),
  });
}

// Anyone (the online checkout): what a voucher of theirs is worth, before
// they order. Needs its code and their phone number. { code, phone }
const checks = new Map();
Parse.Cloud.define('checkVoucher', async (request) => {
  // RelayEats Hosted: on the restaurant's own link only.
  if (!require('./lib/tenant').current()) throw invalid('Open the restaurant’s own link to order');
  const key = String(request.ip || '');
  const now = Date.now();
  const recent = (checks.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (recent.length >= 10) throw forbidden('Too many tries. Try again in a few minutes');
  recent.push(now);
  checks.set(key, recent);
  if (checks.size > 5000) checks.clear();
  const row = await find(request.params?.code, request.params?.phone);
  return { code: row.get('code'), amount: round(row.get('amount')) };
});

// Staff: a customer's open vouchers, by their phone number. { phone }
Parse.Cloud.define('findVouchers', async (request) => {
  await requireRole(request, ['cashier', 'admin', 'finance']);
  const digits = digitsOf(request.params?.phone);
  if (digits.length < 9) throw invalid('Enter the customer’s phone number');
  const { values: config } = await loadConfig();
  const rows = await findAll(new Parse.Query(CLASS).equalTo('status', 'open'));
  return {
    vouchers: rows.filter((row) => samePhone(row.get('phone'), digits)).map((r) => view(r, config)),
  };
});

// Owner / finance: every voucher (open first), and the refund charges.
Parse.Cloud.define('adminListVouchers', async (request) => {
  const { branch } = await requireRole(request, ['admin', 'finance']);
  await backfill();
  const { values: config } = await loadConfig();
  const query = new Parse.Query(CLASS);
  if (branch) query.equalTo('branch', branch);
  const rows = await findAll(query);
  const order = { open: 0, used: 1, refunded: 2 };
  return {
    // Open first, newest first.
    vouchers: rows
      .sort((a, b) => order[a.get('status')] - order[b.get('status')] || b.createdAt - a.createdAt)
      .map((row) => view(row, config)),
    charges: {
      flat: round(config.refundChargeFlat),
      percent: Number(config.refundChargePercent) || 0,
    },
  };
});

// Owner: what sending a refund back costs: a flat amount and / or a share
// of the refund. { flat, percent }
Parse.Cloud.define('adminSaveRefundCharges', async (request) => {
  const actor = await requireAdminUnlock(request);
  const flat = Number(request.params?.flat ?? 0);
  const percent = Number(request.params?.percent ?? 0);
  if (!Number.isFinite(flat) || flat < 0 || flat > 1e7)
    throw invalid('The charge must be 0 or more');
  if (!Number.isFinite(percent) || percent < 0 || percent > 50)
    throw invalid('The share must be between 0 and 50%');
  const { object: config, values } = await loadConfig();
  if (!config) throw invalid('Save the restaurant settings first');
  const before = {
    refundChargeFlat: values.refundChargeFlat,
    refundChargePercent: values.refundChargePercent,
  };
  const next = { refundChargeFlat: Math.round(flat), refundChargePercent: percent };
  config.set(next);
  await config.save(null, MASTER);
  await audit(actor, 'voucher.charges_saved', config, before, next);
  return { flat: next.refundChargeFlat, percent };
});

// Owner: the voucher's money was sent back to the customer, less the
// charges. { id, charges?, note } (charges: what sending it actually cost;
// default from the settings)
async function refund(row, actor, params) {
  if (row.get('status') !== 'open') throw invalid('Only an open voucher can be refunded');
  const note = String(params.note || '')
    .trim()
    .slice(0, 300);
  if (note.length < 5) throw invalid('Say how it was sent back (at least 5 characters)');
  const { values: config } = await loadConfig();
  const amount = round(row.get('amount'));
  const charges =
    params.charges === undefined || params.charges === null || params.charges === ''
      ? refundCharge(config, amount)
      : round(params.charges);
  if (charges < 0 || charges > amount) throw invalid('The charges cannot be more than the refund');
  const now = new Date();
  row.set({
    status: 'refunded',
    refundedAt: now,
    refundedBy: actor,
    refundCharges: charges,
    refundSent: amount - charges,
    refundNote: note,
  });
  await row.save(null, MASTER);
  await audit(
    actor,
    'voucher.refunded',
    row,
    { status: 'open' },
    {
      amount,
      charges,
      sent: amount - charges,
      note,
    },
  );
  // The order it came from shows it as refunded too.
  const source = row.get('sourceOrder');
  if (source) {
    const order = await new Parse.Query('Order').get(source.id, MASTER).catch(() => null);
    if (order) {
      order.set({ refundDue: false, refundedAt: now, refundedBy: actor, refundNote: note });
      await order.save(null, MASTER);
    }
  }
  return { ...view(row, config), by: personName(actor) };
}

Parse.Cloud.define('adminRefundVoucher', async (request) => {
  const actor = await requireAdminUnlock(request);
  const id = String(request.params?.id || '');
  const row = ID.test(id) ? await new Parse.Query(CLASS).get(id, MASTER).catch(() => null) : null;
  if (!row) throw invalid('Voucher not found');
  return refund(row, actor, request.params || {});
});

module.exports = {
  openForOrder,
  backfill,
  find,
  peek,
  spend,
  paidByVoucher,
  refund,
  refundCharge,
  samePhone,
  view,
  CLASS,
};
