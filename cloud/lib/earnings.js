// Relay Hosted: revenue earned from subscription payments, month by month
// (platformAccounting.js). A payment pays for a period (periodStart to
// periodEnd); it is earned evenly, day by day, over that period. Money paid
// for days after a month's end is a prepayment (unearned revenue) at that
// month's end.
//
// Months are calendar months in the platform's time zone, given as
// 'YYYY-MM'; `bounds` turns one into [start, end) instants.

const DAY = 86400000;

// How much of `payment` is earned in [from, to): the share of its period
// inside it. A payment with no period (older records) is earned when paid.
function earnedBetween(payment, from, to) {
  const amount = Number(payment.amount) || 0;
  const start = payment.periodStart ? new Date(payment.periodStart).getTime() : NaN;
  const end = payment.periodEnd ? new Date(payment.periodEnd).getTime() : NaN;
  if (!(end > start)) {
    const paid = new Date(payment.paidAt).getTime();
    return paid >= from && paid < to ? amount : 0;
  }
  const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
  return (amount * overlap) / (end - start);
}

// Rounds a set of shares to whole currency units without losing a unit:
// the last share takes the remainder.
function roundShares(total, shares) {
  const rounded = shares.map((share) => Math.round(share));
  const diff = Math.round(total) - rounded.reduce((a, b) => a + b, 0);
  if (rounded.length) rounded[rounded.length - 1] += diff;
  return rounded;
}

// One payment, seen from month [from, to): earned before the month, in it,
// and still deferred (prepaid) at its end. Whole units; they add up to the
// amount.
function splitPayment(payment, from, to) {
  const amount = Math.round(Number(payment.amount) || 0);
  const before = earnedBetween(payment, -Infinity, from);
  const during = earnedBetween(payment, from, to);
  const after = amount - before - during;
  const [b, d, a] = roundShares(amount, [before, during, Math.max(0, after)]);
  return { earnedBefore: b, earnedInMonth: d, deferredAfter: a };
}

// The month's figures from paid payments [{ amount, paidAt, periodStart,
// periodEnd, … }] and the month's [from, to).
function monthEarnings(payments, from, to) {
  const rows = [];
  const totals = {
    received: 0,
    earned: 0,
    earnedFromThisMonth: 0,
    earnedFromEarlier: 0,
    deferredFromThisMonth: 0,
    prepaidAtEnd: 0,
  };
  for (const payment of payments) {
    const paid = new Date(payment.paidAt).getTime();
    if (!(paid < to)) continue;
    const split = splitPayment(payment, from, to);
    const inMonth = paid >= from;
    if (inMonth) {
      totals.received += Math.round(Number(payment.amount) || 0);
      totals.earnedFromThisMonth += split.earnedInMonth;
      totals.deferredFromThisMonth += split.deferredAfter;
    } else totals.earnedFromEarlier += split.earnedInMonth;
    totals.earned += split.earnedInMonth;
    totals.prepaidAtEnd += split.deferredAfter;
    if (inMonth || split.earnedInMonth || split.deferredAfter)
      rows.push({ ...payment, ...split, paidInMonth: inMonth });
  }
  rows.sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));
  return { totals, rows };
}

module.exports = { DAY, earnedBetween, splitPayment, monthEarnings, roundShares };
