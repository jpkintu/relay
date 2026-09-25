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

function sumBy(rows, pick) {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

module.exports = { COMMISSION_TYPES, ROUNDING_STEPS, roundCommission, computeCommission, sumBy };
