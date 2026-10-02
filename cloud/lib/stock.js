// Stock (Admin → Purchases & expenses → Stock, stock.js) as pure functions
// of plain records, so the maths can be unit-tested.
//
// Relay uses the periodic method, as most restaurants do: stock is counted
// now and then (a stock count, per branch), not deducted dish by dish.
// - Stock on hand at a moment is the value of each branch's latest count
//   before it (the whole restaurant: the branches added up).
// - Cost of goods sold for a period is: stock at its start + purchases in it
//   − stock at its end (lib/accounts.js).
// - Stock is kept by branch: each branch has its own counts, what it has of
//   each item and its own reorder levels. Between counts, what a branch has
//   of an item is its latest count plus what purchases for that branch
//   linked to the item brought in since.

const round = (value) => Math.round(Number(value) || 0);
const qty = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

// counts: [{ branch, at, total, lines }] (not voided). The latest count of
// each branch before `end` (all of them when `end` is null).
function latestByBranch(counts, end = null) {
  const out = new Map();
  for (const count of counts) {
    if (end && !(count.at < end)) continue;
    const key = count.branch || '';
    const seen = out.get(key);
    if (!seen || count.at > seen.at) out.set(key, count);
  }
  return out;
}

// The value of stock on hand at `end`.
function stockValueAt(counts, end) {
  let total = 0;
  for (const count of latestByBranch(counts, end).values()) total += round(count.total);
  return total;
}

// What each branch has of each item now: its quantity in the branch's latest
// count plus the branch's linked purchase lines since (purchases: [{ branch,
// at, lines: [{ itemId, quantity }] }]). `idOf` maps an id written on a line
// to the item's id (a restored item keeps its old id as a second key).
// → Map(itemId → Map(branch → { quantity, counted })) — counted: it is in
// the branch's latest count.
function onHandByBranch(counts, purchases, idOf = (id) => id) {
  const out = new Map();
  const add = (id, branch, quantity, counted) => {
    const key = idOf(id);
    if (!key) return;
    if (!out.has(key)) out.set(key, new Map());
    const row = out.get(key).get(branch) || { quantity: 0, counted: false };
    row.quantity = qty(row.quantity + quantity);
    row.counted = row.counted || counted;
    out.get(key).set(branch, row);
  };
  const latest = latestByBranch(counts);
  for (const [branch, count] of latest)
    for (const line of count.lines || [])
      add(line.itemId, branch, Number(line.quantity) || 0, true);
  for (const purchase of purchases) {
    const branch = purchase.branch || '';
    const since = latest.get(branch);
    if (since && !(purchase.at > since.at)) continue;
    for (const line of purchase.lines || [])
      if (line.itemId) add(line.itemId, branch, Number(line.quantity) || 0, false);
  }
  return out;
}

// The branches added up: Map(itemId → { quantity, counted }).
function onHand(counts, purchases, idOf = (id) => id) {
  const out = new Map();
  for (const [id, branches] of onHandByBranch(counts, purchases, idOf)) {
    let quantity = 0;
    let counted = false;
    for (const row of branches.values()) {
      quantity = qty(quantity + row.quantity);
      counted = counted || row.counted;
    }
    out.set(id, { quantity, counted });
  }
  return out;
}

// An item's reorder level in a branch: the branch's own, else the item's.
const reorderLevelFor = (item, branch) => {
  const own = item.reorderLevels?.[branch || ''];
  return own === undefined || own === null ? Number(item.reorderLevel) || 0 : Number(own) || 0;
};

// Lines of a count: [{ itemId, name, unit, quantity, unitCost }] → priced
// lines and the total value.
function priceCount(lines) {
  const priced = lines.map((line) => {
    const quantity = qty(line.quantity);
    const unitCost = round(line.unitCost);
    return { ...line, quantity, unitCost, value: Math.round(quantity * unitCost) };
  });
  return { lines: priced, total: priced.reduce((n, line) => n + line.value, 0) };
}

// At or under the reorder level (only with one). With a branch, its level.
const isLow = (item, quantity, branch) => {
  const level =
    branch === undefined ? Number(item.reorderLevel) || 0 : reorderLevelFor(item, branch);
  return level > 0 && qty(quantity) <= level;
};

module.exports = {
  latestByBranch,
  stockValueAt,
  onHandByBranch,
  onHand,
  reorderLevelFor,
  priceCount,
  isLow,
};
