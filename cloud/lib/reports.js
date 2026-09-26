// Pure reporting helpers. Cloud functions turn orders into plain "facts"
// ({ status, total, subtotal, deliveryFee, commission, method, provider, … })
// and these functions aggregate them, so the maths can be unit-tested.
//
// Revenue is the total (food + delivery fee) of DELIVERED orders.

const round = (value) => Math.round(Number(value) || 0);
const isDelivered = (fact) => fact.status === 'DELIVERED';
// Money the restaurant actually has: cash counted in by a cashier, or mobile
// money a cashier found on the merchant statement.
const isConfirmed = (fact) =>
  fact.method === 'cash'
    ? fact.cashStatus === 'RECONCILED'
    : fact.method === 'mobile_money'
      ? fact.paymentStatus === 'VERIFIED'
      : true;
const OPEN = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'];

// % change from previous to current; null when there is nothing to compare.
function growth(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function summarize(facts) {
  const delivered = facts.filter(isDelivered);
  const revenue = delivered.reduce((n, f) => n + round(f.total), 0);
  // `commission` is rider pay: commission + the delivery fee, which is passed
  // on to the rider in full.
  const commission = delivered.reduce((n, f) => n + round(f.commission), 0);
  const deliveryPay = delivered.reduce((n, f) => n + round(f.deliveryPay ?? f.deliveryFee), 0);
  const confirmed = delivered.filter(isConfirmed);
  const perCustomer = new Map();
  for (const fact of delivered) {
    if (!fact.customerKey) continue;
    perCustomer.set(fact.customerKey, (perCustomer.get(fact.customerKey) || 0) + 1);
  }
  const minutes = delivered
    .filter((f) => f.deliveredAt && f.createdAt)
    .map((f) => (f.deliveredAt - f.createdAt) / 60000);
  return {
    orders: facts.length,
    delivered: delivered.length,
    cancelled: facts.filter((f) => f.status === 'CANCELLED').length,
    rejected: facts.filter((f) => f.restaurantStatus === 'rejected').length,
    open: facts.filter((f) => OPEN.includes(f.status)).length,
    revenue,
    foodSales: delivered.reduce((n, f) => n + round(f.subtotal), 0),
    deliveryFees: delivered.reduce((n, f) => n + round(f.deliveryFee), 0),
    commission,
    riderCommission: commission - deliveryPay,
    net: revenue - commission,
    avgOrder: delivered.length ? Math.round(revenue / delivered.length) : 0,
    // Confirmed money only; the rest is still with riders or waiting for a check.
    cashSales: confirmed.filter((f) => f.method === 'cash').reduce((n, f) => n + round(f.total), 0),
    mobileMoneySales: confirmed
      .filter((f) => f.method === 'mobile_money')
      .reduce((n, f) => n + round(f.total), 0),
    unconfirmedSales: delivered
      .filter((f) => !isConfirmed(f))
      .reduce((n, f) => n + round(f.total), 0),
    customers: perCustomer.size,
    repeatCustomers: [...perCustomer.values()].filter((count) => count > 1).length,
    avgDeliveryMinutes: minutes.length
      ? Math.round(minutes.reduce((n, m) => n + m, 0) / minutes.length)
      : null,
  };
}

// One row per bucket key (keys come from bucketKeys, so empty periods are 0).
// `keyOf(fact)` returns the fact's bucket. Each row also carries the % change
// in revenue from the bucket before it.
function series(facts, keys, keyOf) {
  const rows = new Map(
    keys.map((key) => [key, { key, orders: 0, delivered: 0, revenue: 0, commission: 0 }]),
  );
  for (const fact of facts) {
    const row = rows.get(keyOf(fact));
    if (!row) continue;
    row.orders += 1;
    if (!isDelivered(fact)) continue;
    row.delivered += 1;
    row.revenue += round(fact.total);
    row.commission += round(fact.commission);
  }
  let previous = null;
  return [...rows.values()].map((row) => {
    const out = {
      ...row,
      avgOrder: row.delivered ? Math.round(row.revenue / row.delivered) : 0,
      revenueChange: previous ? growth(row.revenue, previous.revenue) : null,
      commissionChange: previous ? growth(row.commission, previous.commission) : null,
    };
    previous = row;
    return out;
  });
}

// Lines: { name, qty, total, accompaniments: string[] } from delivered orders.
function itemSales(lines) {
  const byName = new Map();
  for (const line of lines) {
    const row = byName.get(line.name) || { name: line.name, qty: 0, revenue: 0, orders: 0 };
    row.qty += round(line.qty);
    row.revenue += round(line.total);
    row.orders += 1;
    byName.set(line.name, row);
  }
  const revenue = [...byName.values()].reduce((n, row) => n + row.revenue, 0);
  return [...byName.values()]
    .map((row) => ({
      ...row,
      share: revenue ? Math.round((row.revenue / revenue) * 1000) / 10 : 0,
      avgPrice: row.qty ? Math.round(row.revenue / row.qty) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name));
}

function accompanimentCounts(lines) {
  const counts = new Map();
  for (const line of lines)
    for (const name of line.accompaniments || [])
      counts.set(name, (counts.get(name) || 0) + round(line.qty));
  return [...counts.entries()]
    .map(([name, servings]) => ({ name, servings }))
    .sort((a, b) => b.servings - a.servings || a.name.localeCompare(b.name));
}

function riderStats(facts) {
  const byRider = new Map();
  for (const fact of facts) {
    if (!fact.riderId) continue;
    const row = byRider.get(fact.riderId) || {
      riderId: fact.riderId,
      rider: fact.rider,
      orders: 0,
      delivered: 0,
      cancelled: 0,
      revenue: 0,
      commission: 0,
      minutes: [],
    };
    row.orders += 1;
    if (fact.status === 'CANCELLED') row.cancelled += 1;
    if (isDelivered(fact)) {
      row.delivered += 1;
      row.revenue += round(fact.total);
      row.commission += round(fact.commission);
      if (fact.deliveredAt && fact.createdAt)
        row.minutes.push((fact.deliveredAt - fact.createdAt) / 60000);
    }
    byRider.set(fact.riderId, row);
  }
  return [...byRider.values()]
    .map(({ minutes, ...row }) => ({
      ...row,
      avgDeliveryMinutes: minutes.length
        ? Math.round(minutes.reduce((n, m) => n + m, 0) / minutes.length)
        : null,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
}

// Orders and revenue by local hour (0-23) and weekday (0 = Monday).
// `clockOf(fact)` returns { hour, weekday }.
function timeOfDay(facts, clockOf) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));
  const weekdays = Array.from({ length: 7 }, (_, weekday) => ({ weekday, orders: 0, revenue: 0 }));
  for (const fact of facts) {
    const { hour, weekday } = clockOf(fact);
    hours[hour].orders += 1;
    weekdays[weekday].orders += 1;
    if (isDelivered(fact)) {
      hours[hour].revenue += round(fact.total);
      weekdays[weekday].revenue += round(fact.total);
    }
  }
  return { hours, weekdays };
}

// Confirmed money by how it was paid: cash counted in by a cashier, or
// verified mobile money per provider. Cash still with riders and mobile money
// waiting for a check are left out (see unconfirmedSales in summarize).
function paymentMix(facts) {
  const byKey = new Map();
  for (const fact of facts.filter(isDelivered).filter(isConfirmed)) {
    const key = fact.method === 'mobile_money' ? fact.provider || 'mobile_money' : 'cash';
    const row = byKey.get(key) || { key, orders: 0, amount: 0 };
    row.orders += 1;
    row.amount += round(fact.total);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.amount - a.amount);
}

function channelMix(facts) {
  const byKey = new Map();
  for (const fact of facts.filter(isDelivered)) {
    const key = fact.channel || 'unknown';
    const row = byKey.get(key) || { key, orders: 0, amount: 0 };
    row.orders += 1;
    row.amount += round(fact.total);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.amount - a.amount);
}

module.exports = {
  growth,
  summarize,
  series,
  itemSales,
  accompanimentCounts,
  riderStats,
  timeOfDay,
  paymentMix,
  channelMix,
};
