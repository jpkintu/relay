// Pure money helpers. No Parse dependency, so they can be unit-tested.

const COMMISSION_TYPES = ['per_order', 'percent', 'hybrid'];
const ROUNDING_STEPS = { none: 0, up_100: 100, up_500: 500, up_1000: 1000 };

function roundCommission(amount, rounding = 'none') {
  const whole = Math.round(Number(amount) || 0);
  const step = ROUNDING_STEPS[rounding] || 0;
  return step ? Math.ceil(whole / step) * step : whole;
}

// per_order: flat fee; percent: share of subtotal; hybrid: flat base + share.
// Commission is calculated on the subtotal (not the delivery fee).
function computeCommission({ type, perOrder, percent, subtotal, rounding }) {
  const flat = Number(perOrder) || 0;
  const share = ((Number(subtotal) || 0) * (Number(percent) || 0)) / 100;
  const raw = type === 'percent' ? share : type === 'hybrid' ? flat + share : flat;
  return roundCommission(raw, rounding);
}

// What the rider is owed for one delivered order: commission plus the
// delivery fee. Orders delivered before the fee was added to rider pay stored
// only the commission (no `deliveryPay`), so the fee is added for them here.
function riderPay({ commissionAmount, deliveryPay, deliveryFee }) {
  const commission = Number(commissionAmount) || 0;
  if (deliveryPay !== undefined && deliveryPay !== null) return commission;
  return commission + (Number(deliveryFee) || 0);
}

// riderPay for a Parse Order.
const orderRiderPay = (order) =>
  riderPay({
    commissionAmount: order.get('commissionAmount'),
    deliveryPay: order.get('deliveryPay'),
    deliveryFee: order.get('deliveryFee'),
  });

function sumBy(rows, pick) {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

module.exports = {
  COMMISSION_TYPES,
  ROUNDING_STEPS,
  roundCommission,
  computeCommission,
  riderPay,
  orderRiderPay,
  sumBy,
};
