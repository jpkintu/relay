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
  takeOrder,
  findAll,
} = require('./lib/core');
const {
  merchantAccounts,
  cardAccount,
  cleanReference,
  referenceProblem,
} = require('./lib/mobileMoney');
const { dateKey } = require('./lib/dates');
const { money, notifyUser, notifyStaff, personName } = require('./notifications');

const PENDING = 'PENDING_VERIFICATION';

// Validates provider + transaction ID and makes sure the ID has not already
// been used on another order. Returns the cleaned values.
// With automatic payments on (Admin → Payments) and no transaction ID, the
// order is marked for a payment request to `payerPhone` instead
// (collections.js sends it once the order is saved). Callers set `request`
// on the order along with the provider and reference.
async function checkMobileMoney(config, providerParam, referenceParam, excludeOrderId, payerPhone) {
  const accounts = merchantAccounts(config);
  if (!accounts.length)
    throw invalid('Mobile money is not set up. Ask the owner to add merchant codes in Settings');
  const provider = String(providerParam || '');
  const account = accounts.find((entry) => entry.provider === provider);
  if (!account) throw invalid(`Choose ${accounts.map((a) => a.label).join(' or ')}`);
  const reference = cleanReference(referenceParam);
  if (!reference && account.auto) {
    const { payerNumber } = require('./lib/momoApi');
    if (!payerNumber(provider, payerPhone, config.momoDialCode || '256'))
      throw invalid(`Enter the customer’s ${account.label} number to send the payment request`);
    const { newRequest } = require('./collections');
    return { provider, reference: '', auto: true, request: newRequest(payerPhone) };
  }
  const problem = referenceProblem(reference);
  if (problem) throw invalid(problem);
  await refuseDuplicate(provider, reference, excludeOrderId);
  return { provider, reference, auto: false, request: {} };
}

// A transaction ID must not be on another live order of the same provider.
async function refuseDuplicate(provider, reference, excludeOrderId) {
  const query = new Parse.Query('Order');
  query.equalTo('paymentProvider', provider);
  query.equalTo('paymentReference', reference);
  query.notEqualTo('paymentStatus', 'REJECTED');
  if (excludeOrderId) query.notEqualTo('objectId', excludeOrderId);
  const duplicate = await query.first(MASTER);
  if (duplicate)
    throw invalid(`This transaction ID was already used on ${duplicate.get('orderCode')}`);
}

// Card payments (counter only): the transaction ID from the card machine's
// slip, checked by a cashier against the machine's report like a merchant
// code payment. Same shape as checkMobileMoney's answer.
async function checkCard(config, referenceParam, excludeOrderId) {
  const account = cardAccount(config);
  if (!account)
    throw invalid('Card payments are not set up. The owner switches them on in Settings');
  const reference = cleanReference(referenceParam);
  if (!reference) throw invalid('Enter the transaction ID from the card machine slip');
  if (!/^[A-Z0-9.-]{4,40}$/.test(reference))
    throw invalid('A transaction ID has 4 to 40 letters or digits');
  await refuseDuplicate('card', reference, excludeOrderId);
  return { provider: 'card', reference, auto: false, request: {} };
}

// Records that a mobile money payment arrived (VERIFIED) or did not
// (REJECTED), with what follows: a rider who delivered owes the total as
// cash, an eat-in or pick-up bill opens again, the rider is told. Used by the
// cashier's check (actor = the cashier) and automatic payments (actor null).
async function settlePayment(order, { received, reason = '', actor }) {
  order.set({
    paymentStatus: received ? 'VERIFIED' : 'REJECTED',
    paymentCheckedAt: new Date(),
    paymentRejectReason: received ? '' : reason,
  });
  // Automatic payments are confirmed by the provider, not a person.
  if (actor) order.set('paymentCheckedBy', actor);
  else if (order.has('paymentCheckedBy')) order.unset('paymentCheckedBy');
  // A delivered order whose mobile money did not arrive: the rider collected
  // nothing we can see, so they owe the total as cash (it goes back on their
  // cash list) until they hand it over or send a correct transaction ID.
  const owedByRider = !received && order.get('status') === 'DELIVERED' && !!order.get('createdBy');
  // Cancelled meanwhile (a payment request still on the customer's phone
  // when the order was cancelled): money that arrives is owed back.
  const cancelled = order.get('status') === 'CANCELLED';
  const refundDue = received && cancelled;
  if (refundDue) order.set('refundDue', true);
  // Eat-in / pick-up paid by mobile money that did not arrive: the bill is
  // open again; the cashier takes payment another way.
  if (!received && !cancelled && ['eat_in', 'pickup'].includes(order.get('orderType')))
    order.set({ billOpen: true, cashStatus: 'UNPAID', amountToCollect: order.get('total') });
  if (owedByRider)
    order.set({
      paymentMethod: 'cash',
      amountCollected: Number(order.get('total') || 0),
      cashStatus: 'WITH_RIDER',
    });
  await order.save(null, MASTER);
  // Served already (eat in) and now paid: it is finished.
  if (received) await require('./orders').closeServed(order, actor || null);
  await audit(
    actor,
    refundDue ? 'payment.after_cancel' : received ? 'payment.verified' : 'payment.rejected',
    order,
    { paymentStatus: PENDING },
    {
      paymentStatus: order.get('paymentStatus'),
      provider: order.get('paymentProvider'),
      reference: order.get('paymentReference'),
      amount: order.get('total'),
      reason,
      ...(!actor && { auto: true }),
    },
  );
  if (refundDue) {
    const { values: config } = await loadConfig();
    const [voucher] = await require('./vouchers').openForOrder(order);
    await notifyStaff({
      kind: 'payment.refund_due',
      tone: 'alert',
      title: `Payment arrived for cancelled order ${order.get('orderCode')}`,
      body: `${money(config, order.get('total'))} by ${order.get('paymentProvider') || 'mobile money'} (${order.get('paymentReference') || 'no reference'}) from ${order.get('payRequestPhone') || order.get('customerPhone') || 'the customer'}. It is the customer's voucher${voucher ? ` ${voucher.get('code')}` : ''}: they can spend it on a new order, or you refund it (Accounting → Refunds).`,
      link: `/admin/orders/${order.id}`,
      order,
    });
    return;
  }
  const code = order.get('orderCode');
  const { values: config } = await loadConfig();
  if (order.get('createdBy'))
    await notifyUser(order.get('createdBy'), {
      kind: received ? 'payment.verified' : 'payment.rejected',
      tone: received ? 'update' : 'alert',
      title: received ? `Payment confirmed for ${code}` : `Payment not received for ${code}`,
      body: received
        ? order.get('status') === 'DELIVERED'
          ? 'It is off your list.'
          : 'The kitchen can start on it.'
        : owedByRider
          ? `${reason}. You owe ${money(config, order.get('total'))}: hand it over in cash, or send the correct transaction ID.`
          : actor
            ? `${reason}. Correct the transaction ID or cancel the order.`
            : `${reason}. Send the request again, type the transaction ID, or cancel the order.`,
      link: `/rider/order/${order.id}`,
      order,
    });
  // Paid automatically: the kitchen board and payments list change on their
  // own, so tell the staff.
  if (!actor)
    await notifyStaff({
      kind: received ? 'payment.verified' : 'payment.rejected',
      tone: received ? 'update' : 'alert',
      title: received
        ? `${code}: ${money(config, order.get('total'))} received automatically`
        : `${code}: automatic payment did not go through`,
      body: received ? order.get('paymentReference') || '' : reason,
      link: '/cashier/payments',
      order,
    });
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
  await takeOrder(order, actor, role);
  await settlePayment(order, { received, reason, actor });
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
  // A rejected door payment is owed as cash; once that cash is handed over it
  // can no longer be switched back to mobile money.
  const owedAsCash = order.get('status') === 'DELIVERED' && order.get('paymentMethod') === 'cash';
  if (owedAsCash && order.get('cashStatus') !== 'WITH_RIDER')
    throw invalid('This order was already handed over as cash');
  const { values: config } = await loadConfig();
  // Card: taken at the counter, so only a cashier or the owner corrects it.
  const byCard = order.get('paymentMethod') === 'card';
  if (byCard && !['cashier', 'admin'].includes(role)) throw forbidden('Not allowed');
  const momo = byCard
    ? await checkCard(config, request.params.reference, order.id)
    : await checkMobileMoney(
        config,
        request.params.provider,
        request.params.reference,
        order.id,
        request.params.payerPhone || order.get('customerPhone'),
      );
  const { provider, reference } = momo;
  const before = {
    provider: order.get('paymentProvider'),
    reference: order.get('paymentReference'),
    paymentStatus: order.get('paymentStatus'),
  };
  order.set({
    ...momo.request,
    paymentProvider: provider,
    paymentReference: reference,
    paymentStatus: PENDING,
    paymentRejectReason: '',
    ...(owedAsCash && {
      paymentMethod: 'mobile_money',
      amountCollected: 0,
      cashStatus: 'NOT_APPLICABLE',
    }),
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
    ? [
        user.get('riderCode') || user.get('cashierCode') || user.get('financeCode'),
        user.get('name'),
      ]
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
    createdAt: require('./lib/placed').placedAt(order),
    checkedAt: order.get('paymentCheckedAt') || null,
    checkedBy: nameOf(order.get('paymentCheckedBy')),
    rejectReason: order.get('paymentRejectReason') || '',
    holderId: order.get('cashier')?.id || '',
    holderName: order.get('cashierName') || '',
    // Automatic payments: queued | pending | successful | failed | closed.
    payRequest: order.get('payRequestStatus') || '',
    payRequestError: order.get('payRequestError') || '',
    auto: order.get('paymentAuto') === true,
  };
}

// Cashier reconciliation: payments waiting for a check, plus today's
// confirmed and rejected ones with totals per provider (compare these with
// the Airtel/MTN merchant statements).
Parse.Cloud.define('getMobileMoneyLedger', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  // A cashier checks their own branch's payments; the owner every branch.
  const branch = role === 'cashier' ? (await user.fetch(MASTER)).get('branch') : null;
  // Bring automatic payment requests up to date before listing.
  await require('./collections').sweepRequests();
  const { values: config } = await loadConfig();
  const pendingQuery = new Parse.Query('Order');
  pendingQuery.equalTo('paymentStatus', PENDING);
  pendingQuery.include(['createdBy']);
  if (branch) pendingQuery.equalTo('branch', branch);
  const checkedQuery = new Parse.Query('Order');
  checkedQuery.containedIn('paymentStatus', ['VERIFIED', 'REJECTED']);
  checkedQuery.greaterThanOrEqualTo('paymentCheckedAt', new Date(Date.now() - 48 * 3600 * 1000));
  checkedQuery.include(['createdBy', 'paymentCheckedBy']);
  if (branch) checkedQuery.equalTo('branch', branch);
  const [pending, checked] = await Promise.all([
    findAll(pendingQuery).then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt)),
    findAll(checkedQuery).then((rows) =>
      rows.sort((a, b) => b.get('paymentCheckedAt') - a.get('paymentCheckedAt')),
    ),
  ]);
  const today = dateKey(new Date(), config.timezone);
  const checkedToday = checked.filter(
    (order) => dateKey(order.get('paymentCheckedAt'), config.timezone) === today,
  );
  const verified = checkedToday.filter((order) => order.get('paymentStatus') === 'VERIFIED');
  const card = cardAccount(config);
  const totals = [...merchantAccounts(config), ...(card ? [card] : [])].map((account) => {
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

module.exports = { checkMobileMoney, checkCard, settlePayment, PENDING };
