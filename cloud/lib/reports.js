// Pure reporting helpers. Cloud functions turn orders into plain "facts"
// ({ status, total, subtotal, deliveryFee, commission, method, provider, … })
// and these functions aggregate them, so the maths can be unit-tested.
//
// Revenue is the total (food + delivery fee) of DELIVERED orders.

const round = (value) => Math.round(Number(value) || 0);
const isDelivered = (fact) => fact.status === 'DELIVERED';
// Money the restaurant actually has: cash counted in by a cashier, or mobile
// money / card payments a cashier found on the statement.
const isConfirmed = (fact) =>
  fact.method === 'cash'
    ? ['RECONCILED', 'IN_TILL'].includes(fact.cashStatus)
    : ['mobile_money', 'card'].includes(fact.method)
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
  // Order-to-door time is for deliveries; eat-in / pick-up have their own.
  const minutesOf = (rows) =>
    rows
      .filter((f) => f.deliveredAt && f.createdAt)
      .map((f) => (f.deliveredAt - f.createdAt) / 60000);
  const average = (values) =>
    values.length ? Math.round(values.reduce((n, m) => n + m, 0) / values.length) : null;
  const atCounter = (f) => ['eat_in', 'pickup'].includes(f.orderType);
  const minutes = minutesOf(delivered.filter((f) => !atCounter(f)));
  const counterMinutes = minutesOf(delivered.filter(atCounter));
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
    cardSales: confirmed.filter((f) => f.method === 'card').reduce((n, f) => n + round(f.total), 0),
    unconfirmedSales: delivered
      .filter((f) => !isConfirmed(f))
      .reduce((n, f) => n + round(f.total), 0),
    customers: perCustomer.size,
    repeatCustomers: [...perCustomer.values()].filter((count) => count > 1).length,
    avgDeliveryMinutes: average(minutes),
    avgCounterMinutes: average(counterMinutes),
    // Delivered orders by how they came in.
    byType: typeMix(facts),
    // Sales by who took the order: riders, or the counter (cashier).
    riderSales: delivered
      .filter((f) => f.source !== 'counter')
      .reduce((n, f) => n + round(f.total), 0),
    counterSales: delivered
      .filter((f) => f.source === 'counter')
      .reduce((n, f) => n + round(f.total), 0),
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

// Servings per accompaniment, and what charged ones brought in
// (`accompanimentPrices` lines up with `accompaniments`; missing = free).
function accompanimentCounts(lines) {
  const counts = new Map();
  for (const line of lines)
    (line.accompaniments || []).forEach((name, i) => {
      const row = counts.get(name) || { servings: 0, revenue: 0 };
      row.servings += round(line.qty);
      row.revenue += round(line.qty) * Number(line.accompanimentPrices?.[i] || 0);
      counts.set(name, row);
    });
  return [...counts.entries()]
    .map(([name, row]) => ({ name, ...row }))
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
    const key =
      fact.method === 'mobile_money'
        ? fact.provider || 'mobile_money'
        : fact.method === 'card'
          ? 'card'
          : 'cash';
    const row = byKey.get(key) || { key, orders: 0, amount: 0 };
    row.orders += 1;
    row.amount += round(fact.total);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.amount - a.amount);
}

// Sales per branch: orders placed, delivered and their revenue.
function branchMix(facts, names = {}) {
  const rows = new Map();
  for (const fact of facts) {
    const key = fact.branchId || '';
    const row = rows.get(key) || {
      key,
      name: names[key] || 'No branch',
      orders: 0,
      delivered: 0,
      amount: 0,
    };
    row.orders += 1;
    if (isDelivered(fact)) {
      row.delivered += 1;
      row.amount += round(fact.total);
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

// Delivered orders and sales by kind: delivery, eat in, pick up.
function typeMix(facts) {
  const rows = { delivery: 0, eat_in: 0, pickup: 0 };
  const amounts = { delivery: 0, eat_in: 0, pickup: 0 };
  for (const fact of facts.filter(isDelivered)) {
    const key = fact.orderType in rows ? fact.orderType : 'delivery';
    rows[key] += 1;
    amounts[key] += round(fact.total);
  }
  return Object.keys(rows).map((key) => ({ key, orders: rows[key], amount: amounts[key] }));
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

// Till differences over time. `shifts`: closed cashier shifts
// { day, cashier, variance } (variance < 0 = short, > 0 = over). Returns a row
// per day (oldest first) and per cashier (most short first).
function tillTrend(shifts) {
  const closed = shifts.filter((s) => typeof s.variance === 'number');
  const add = (map, key, s) => {
    const row = map.get(key) || { shifts: 0, short: 0, over: 0, net: 0, worst: 0 };
    row.shifts += 1;
    if (s.variance < 0) row.short += -s.variance;
    if (s.variance > 0) row.over += s.variance;
    row.net += s.variance;
    if (Math.abs(s.variance) > Math.abs(row.worst)) row.worst = s.variance;
    map.set(key, row);
  };
  const days = new Map();
  const cashiers = new Map();
  for (const s of closed) {
    add(days, s.day, s);
    add(cashiers, s.cashier, s);
  }
  return {
    days: [...days.entries()]
      .map(([day, row]) => ({ day, ...row }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    cashiers: [...cashiers.entries()]
      .map(([cashier, row]) => ({ cashier, ...row }))
      .sort((a, b) => b.short - a.short || a.cashier.localeCompare(b.cashier)),
    closedShifts: closed.length,
    shortShifts: closed.filter((s) => s.variance < 0).length,
  };
}

module.exports = {
  isConfirmed,
  branchMix,
  tillTrend,
  growth,
  summarize,
  series,
  itemSales,
  accompanimentCounts,
  riderStats,
  timeOfDay,
  paymentMix,
  channelMix,
  typeMix,
};
