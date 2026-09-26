import type Parse from 'parse';

// What the rider is owed for a delivered order: commission + delivery fee.
// Orders delivered before the fee was included store the commission only
// (no `deliveryPay`), so the fee is added for them. Matches riderPay in
// cloud/lib/money.js.
export function riderPayOf(order: Parse.Object): number {
  const commission = Number(order.get('commissionAmount') || 0);
  const fee = order.get('deliveryPay') === undefined ? Number(order.get('deliveryFee') || 0) : 0;
  return commission + fee;
}
