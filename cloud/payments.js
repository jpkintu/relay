// Mobile money payments (Airtel Money / MTN MoMo merchant codes).
//
// The rider shows the customer the restaurant's merchant code, the customer
// pays, and the rider types the transaction ID from the customer's payment
// message. The order waits in PENDING_VERIFICATION until a cashier checks the
// merchant account and marks it VERIFIED (the kitchen can then accept it) or
// REJECTED (the rider can correct the ID or cancel).

const {
  MASTER,
  invalid,
  forbidden,
  requireRole,
  getRoleName,
  requireUser,
  audit,
  loadConfig,
  requireCashierShift,
} = require('./lib/core');
const { merchantAccounts, cleanReference, referenceProblem } = require('./lib/mobileMoney');
const { dateKey } = require('./lib/dates');
const { notifyUser, notifyStaff, personName } = require('./notifications');

const PENDING = 'PENDING_VERIFICATION';

// Validates provider + transaction ID and makes sure the ID has not already
// been used on another order. Returns the cleaned values.
async function checkMobileMoney(config, providerParam, referenceParam, excludeOrderId) {
  const accounts = merchantAccounts(config);
  if (!accounts.length)
    throw invalid('Mobile money is not set up. Ask the owner to add merchant codes in Settings');
  const provider = String(providerParam || '');
  if (!accounts.some((account) => account.provider === provider))
    throw invalid(`Choose ${accounts.map((a) => a.label).join(' or ')}`);
  const reference = cleanReference(referenceParam);
  const problem = referenceProblem(reference);
  if (problem) throw invalid(problem);
  const query = new Parse.Query('Order');
  query.equalTo('paymentProvider', provider);
  query.equalTo('paymentReference', reference);
  query.notEqualTo('paymentStatus', 'REJECTED');
  if (excludeOrderId) query.notEqualTo('objectId', excludeOrderId);
  const duplicate = await query.first(MASTER);
  if (duplicate)
    throw invalid(`This transaction ID was already used on ${duplicate.get('orderCode')}`);
  return { provider, reference };
}

// Cashier/admin: the money is (or is not) in the merchant account.
Parse.Cloud.define('verifyPayment', async (request) => {
  const { user: actor, role } = await requireRole(request, ['cashier', 'admin']);
  await requireCashierShift(actor, role);
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  if (order.get('paymentStatus') !== PENDING)
    throw invalid('This payment is not waiting for a check');
  const received = request.params.received === true;
  const reason = String(request.params.reason || '')
    .trim()
    .slice(0, 200);
  if (!received && reason.length < 3) throw invalid('Say why the payment was not accepted');
  order.set({
    paymentStatus: received ? 'VERIFIED' : 'REJECTED',
    paymentCheckedBy: actor,
    paymentCheckedAt: new Date(),
    paymentRejectReason: received ? '' : reason,
  });
  await order.save(null, MASTER);
  await audit(
    actor,
    received ? 'payment.verified' : 'payment.rejected',
    order,
    { paymentStatus: PENDING },
    {
      paymentStatus: order.get('paymentStatus'),
      provider: order.get('paymentProvider'),
      reference: order.get('paymentReference'),
      amount: order.get('total'),
      reason,
    },
  );
  const code = order.get('orderCode');
  await notifyUser(order.get('createdBy'), {
    kind: received ? 'payment.verified' : 'payment.rejected',
    tone: received ? 'update' : 'alert',
    title: received ? `Payment confirmed for ${code}` : `Payment not received for ${code}`,
    body: received
      ? 'The kitchen can start on it.'
      : `${reason}. Correct the transaction ID or cancel the order.`,
    link: `/rider/order/${order.id}`,
    order,
  });
  return { paymentStatus: order.get('paymentStatus') };
});

// Rider (or staff): correct a mistyped or rejected transaction ID.
Parse.Cloud.define('resubmitPayment', async (request) => {
  const actor = requireUser(request);
  const order = await new Parse.Query('Order').get(request.params.orderId, MASTER);
  const role = await getRoleName(actor);
  if (order.get('createdBy')?.id !== actor.id && !['cashier', 'admin'].includes(role))
    throw forbidden('Not allowed');
  if (order.get('status') === 'CANCELLED') throw invalid('This order was cancelled');
  if (![PENDING, 'REJECTED'].includes(order.get('paymentStatus')))
    throw invalid('This payment cannot be changed');
  const { values: config } = await loadConfig();
  const { provider, reference } = await checkMobileMoney(
    config,
    request.params.provider,
    request.params.reference,
    order.id,
  );
  const before = {
    provider: order.get('paymentProvider'),
    reference: order.get('paymentReference'),
    paymentStatus: order.get('paymentStatus'),
  };
  order.set({
    paymentProvider: provider,
    paymentReference: reference,
    paymentStatus: PENDING,
    paymentRejectReason: '',
  });
  await order.save(null, MASTER);
  await audit(actor, 'payment.resubmitted', order, before, { provider, reference });
  await notifyStaff({
    kind: 'payment.resubmitted',
    tone: 'new',
    title: `New transaction ID for ${order.get('orderCode')}`,
    body: `${personName(await actor.fetch(MASTER))} · ${reference}`,
    link: '/cashier/payments',
    order,
    except: actor,
  });
  return { paymentStatus: PENDING };
});

const nameOf = (user) =>
  user
    ? [user.get('riderCode') || user.get('cashierCode'), user.get('name')]
        .filter(Boolean)
        .join(' · ')
    : '';

function paymentRow(order) {
  return {
    id: order.id,
    code: order.get('orderCode'),
    customer: order.get('customerName'),
    rider: nameOf(order.get('createdBy')),
    provider: order.get('paymentProvider'),
    reference: order.get('paymentReference'),
    amount: order.get('total'),
    paymentStatus: order.get('paymentStatus'),
    orderStatus: order.get('status'),
    createdAt: order.createdAt,
    checkedAt: order.get('paymentCheckedAt') || null,
    checkedBy: nameOf(order.get('paymentCheckedBy')),
    rejectReason: order.get('paymentRejectReason') || '',
  };
}

// Cashier reconciliation: payments waiting for a check, plus today's
// confirmed and rejected ones with totals per provider (compare these with
// the Airtel/MTN merchant statements).
Parse.Cloud.define('getMobileMoneyLedger', async (request) => {
  await requireRole(request, ['cashier', 'admin']);
  const { values: config } = await loadConfig();
  const pendingQuery = new Parse.Query('Order');
  pendingQuery.equalTo('paymentStatus', PENDING);
  pendingQuery.include(['createdBy']);
  pendingQuery.ascending('createdAt');
  pendingQuery.limit(500);
  const checkedQuery = new Parse.Query('Order');
  checkedQuery.containedIn('paymentStatus', ['VERIFIED', 'REJECTED']);
  checkedQuery.greaterThanOrEqualTo('paymentCheckedAt', new Date(Date.now() - 48 * 3600 * 1000));
  checkedQuery.include(['createdBy', 'paymentCheckedBy']);
  checkedQuery.descending('paymentCheckedAt');
  checkedQuery.limit(1000);
  const [pending, checked] = await Promise.all([
    pendingQuery.find(MASTER),
    checkedQuery.find(MASTER),
  ]);
  const today = dateKey(new Date(), config.timezone);
  const checkedToday = checked.filter(
    (order) => dateKey(order.get('paymentCheckedAt'), config.timezone) === today,
  );
  const verified = checkedToday.filter((order) => order.get('paymentStatus') === 'VERIFIED');
  const totals = merchantAccounts(config).map((account) => {
    const rows = verified.filter((order) => order.get('paymentProvider') === account.provider);
    return {
      ...account,
      count: rows.length,
      amount: rows.reduce((sum, order) => sum + Number(order.get('total') || 0), 0),
    };
  });
  return {
    pending: pending.map(paymentRow),
    verified: verified.map(paymentRow),
    rejected: checkedToday
      .filter((order) => order.get('paymentStatus') === 'REJECTED')
      .map(paymentRow),
    totals,
  };
});

module.exports = { checkMobileMoney, PENDING };
