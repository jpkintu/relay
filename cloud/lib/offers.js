// Relay Hosted: discount and referral codes, which only apply to a
// restaurant that chose to pay at sign-up instead of a free trial, on its
// first payment (cloud/offers.js). `offer`: { type: 'code' | 'referral',
// code, kind: 'percent' | 'amount', value, minMonths }.

// What an offer takes off `list` (the price of `months`), never leaving less
// than `min` to pay (the smallest amount mobile money takes).
function discountFor(offer, list, months, min = 500) {
  if (!offer || !(list > 0)) return 0;
  if (offer.minMonths && months < offer.minMonths) return 0;
  const raw =
    offer.kind === 'percent'
      ? Math.round((list * Number(offer.value)) / 100)
      : Math.round(Number(offer.value));
  return Math.max(0, Math.min(raw, list - min));
}

// "20% off" / "UGX 50,000 off", and the months it needs.
function describe(offer, currency) {
  if (!offer) return '';
  const off =
    offer.kind === 'percent'
      ? `${offer.value}% off`
      : `${currency} ${Math.round(offer.value).toLocaleString('en-US')} off`;
  const months =
    offer.minMonths > 1
      ? ` when paying ${offer.minMonths === 12 ? 'a year' : `${offer.minMonths} months or more`}`
      : '';
  return `${off} your first payment${months}`;
}

// A discount code as people type it: letters and digits, upper case.
const cleanCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

module.exports = { discountFor, describe, cleanCode };
