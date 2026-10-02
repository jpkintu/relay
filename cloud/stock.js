// Stock (Admin → Purchases & expenses → Stock), for the owner and finance.
//
// - Stock items: what the restaurant keeps (rice, cooking oil, sodas…), with
//   a unit, the latest cost per unit and an optional reorder level.
// - Stock is kept by branch: each branch counts its own shelves, has its own
//   quantities and its own reorder levels (an item's level is the default).
// - Stock counts: what was on the shelves at the end of a day, per branch,
//   priced at cost. The latest count is the stock on hand in the accounts
//   (cost of goods sold = stock at the start + purchases − stock at the end;
//   the maths is in lib/stock.js and lib/accounts.js).
// - A purchase line can name its stock item: the item's cost per unit
//   follows the latest purchase, and what is on hand between counts is the
//   latest count plus what was bought since.
//
// Nothing is deleted: an item is archived, a wrong count voided with a reason.

const { MASTER, invalid, audit, loadConfig, findAll, readAcl } = require('./lib/core');
const { isDay, isoDay, startOfDay, addDays } = require('./lib/dates');
const S = require('./lib/stock');
const { branchParam, branchFor } = require('./branches');

const ITEM = 'StockItem';
const COUNT = 'StockCount';
const ACL_ROLES = ['admin', 'finance'];
const ID = /^[A-Za-z0-9]{1,32}$/;
const MAX_QTY = 1000000;
const MAX_COST = 1000000000;

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const nameOf = (user) => (user ? user.get('name') || user.get('username') || '' : '');
const requireFinance = (request) => require('./spending').requireFinance(request);

function quantityOf(value, label) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QTY)
    throw invalid(`${label}: enter the quantity`);
  return Math.round(quantity * 1000) / 1000;
}
function costOf(value, label) {
  const cost = Math.round(Number(value ?? 0));
  if (!Number.isFinite(cost) || cost < 0 || cost > MAX_COST)
    throw invalid(`${label}: enter the cost per unit`);
  return cost;
}

// Items by id; a restored item answers to its old id too (restore.js).
async function itemsById() {
  const rows = await findAll(new Parse.Query(ITEM));
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    if (row.get('restoredFrom')) byId.set(row.get('restoredFrom'), row);
  }
  return { rows, byId };
}

// Counts not voided (optionally one branch, before a moment), as plain rows.
async function countRows(branch, end) {
  const query = new Parse.Query(COUNT);
  query.doesNotExist('voidedAt');
  if (branch) query.equalTo('branch', branch);
  if (end) query.lessThan('countedAt', end);
  return (await findAll(query)).map((row) => ({
    id: row.id,
    branch: row.get('branch')?.id || '',
    at: row.get('countedAt'),
    total: Math.round(Number(row.get('total') || 0)),
    lines: row.get('lines') || [],
  }));
}

// Purchases (not voided) with lines linked to stock items.
async function linkedPurchases(branch) {
  const query = new Parse.Query('Purchase');
  query.doesNotExist('voidedAt');
  query.equalTo('stockLinked', true);
  if (branch) query.equalTo('branch', branch);
  return (await findAll(query)).map((row) => ({
    branch: row.get('branch')?.id || '',
    at: row.get('spentAt'),
    lines: row.get('lines') || [],
  }));
}

// An item with what each branch has of it (`byBranch`: Map(branchId →
// { quantity, counted }); `names`: Map(branchId → name)). With `branch`,
// on hand, low and the reorder level are that branch's; without, on hand
// is the branches added up and the item is low if any branch is.
const itemView = (row, byBranch = new Map(), names = new Map(), branch = null) => {
  const item = {
    id: row.id,
    name: row.get('name'),
    unit: row.get('unit') || '',
    category: row.get('category') || 'food',
    reorderLevel: Number(row.get('reorderLevel') || 0),
    reorderLevels: row.get('reorderLevels') || {},
    unitCost: Number(row.get('unitCost') || 0),
    active: row.get('active') !== false,
    lastBoughtAt: row.get('lastBoughtAt')?.toISOString() || null,
  };
  const branches = [...byBranch]
    .map(([branchId, have]) => ({
      branchId,
      branch: names.get(branchId) || '',
      onHand: have.quantity,
      counted: have.counted,
      reorderLevel: S.reorderLevelFor(item, branchId),
      low: item.active && S.isLow(item, have.quantity, branchId),
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch));
  const shown = branch ? branches.filter((b) => b.branchId === branch.id) : branches;
  const onHand = shown.reduce((n, b) => Math.round((n + b.onHand) * 1000) / 1000, 0);
  const { reorderLevels, ...rest } = item;
  return {
    ...rest,
    reorderLevel: branch ? S.reorderLevelFor(item, branch.id) : item.reorderLevel,
    branchLevels: reorderLevels,
    onHand,
    counted: shown.some((b) => b.counted),
    value: Math.round(onHand * item.unitCost),
    low: shown.some((b) => b.low),
    branches,
  };
};

const countView = (row) => ({
  id: row.id,
  day: row.get('day'),
  branchId: row.get('branch')?.id || '',
  lines: row.get('lines') || [],
  total: Number(row.get('total') || 0),
  notes: row.get('notes') || '',
  countedBy: nameOf(row.get('countedBy')),
  status: row.get('voidedAt') ? 'void' : 'counted',
  voidReason: row.get('voidReason') || '',
});

// { branchId? } → the items with what is on hand (the branch, or all of
// them), the latest counts, and the stock value.
Parse.Cloud.define('listStock', async (request) => {
  await requireFinance(request);
  const branch = await branchParam(request.params.branchId);
  const [{ rows, byId }, counts, purchases] = await Promise.all([
    itemsById(),
    countRows(branch),
    linkedPurchases(branch),
  ]);
  // Every branch's quantities (the breakdown), shown for the one asked for.
  const [allCounts, allPurchases, branchRows] = branch
    ? await Promise.all([countRows(null), linkedPurchases(null), branchList()])
    : [counts, purchases, await branchList()];
  const have = S.onHandByBranch(allCounts, allPurchases, (id) => byId.get(id)?.id || null);
  const names = new Map(branchRows.map((b) => [b.id, b.get('name') || '']));
  const items = rows
    .map((row) => itemView(row, have.get(row.id), names, branch))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const recent = new Parse.Query(COUNT);
  if (branch) recent.equalTo('branch', branch);
  recent.descending('countedAt');
  recent.include('countedBy');
  recent.limit(60);
  const latest = S.latestByBranch(counts);
  return {
    items,
    counts: (await recent.find(MASTER)).map(countView),
    summary: {
      // The value in the accounts: each branch's latest count.
      counted: S.stockValueAt(counts, null),
      lastCounted: [...latest.values()].reduce((day, c) => (!day || c.at > day ? c.at : day), null),
      low: items.filter((item) => item.low).length,
    },
  };
});

const branchList = () => findAll(new Parse.Query('Branch'));

// Owner / finance: add or change a stock item. With `branchId`, the reorder
// level is that branch's own (the item's level stays the default).
// { id?, name, unit, category, reorderLevel, unitCost, active, branchId? }
Parse.Cloud.define('saveStockItem', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params || {};
  const { PURCHASE_CATEGORIES } = require('./spending');
  const name = clean(p.name, 80);
  if (name.length < 2) throw invalid('Name the stock item');
  let row;
  if (p.id) {
    if (!ID.test(String(p.id))) throw invalid('Unknown stock item');
    row = await new Parse.Query(ITEM).get(String(p.id), MASTER).catch(() => null);
    if (!row) throw invalid('Unknown stock item');
  } else row = new Parse.Object(ITEM);
  const same = new Parse.Query(ITEM);
  same.matches('name', new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  const twin = await same.first(MASTER);
  if (twin && twin.id !== row.id) throw invalid(`There is already a stock item called ${name}`);
  const before = row.id
    ? {
        name: row.get('name'),
        unit: row.get('unit'),
        category: row.get('category'),
        reorderLevel: row.get('reorderLevel'),
        reorderLevels: row.get('reorderLevels'),
        unitCost: row.get('unitCost'),
        active: row.get('active'),
      }
    : null;
  const branch = await branchParam(p.branchId);
  const level = quantityOf(p.reorderLevel ?? 0, name);
  const next = {
    name,
    unit: clean(p.unit, 20) || 'pcs',
    category: PURCHASE_CATEGORIES.includes(p.category) ? p.category : 'food',
    ...(branch
      ? {
          reorderLevels: { ...(row.get('reorderLevels') || {}), [branch.id]: level },
          ...(!row.id && { reorderLevel: level }),
        }
      : { reorderLevel: level }),
    unitCost: costOf(p.unitCost, name),
    active: p.active !== false,
  };
  row.set(next);
  if (!row.id) row.setACL(readAcl(null, ACL_ROLES));
  await row.save(null, MASTER);
  await audit(actor, before ? 'stock.item_updated' : 'stock.item_added', row, before, next);
  return itemView(row, new Map(), new Map(), branch);
});

// The moment a count stands for: the end of its day (restaurant time), so
// it is the closing stock of that day and the opening stock of the next.
const countedAtOf = (day, config) =>
  new Date(startOfDay(addDays(day, 1), config.timezone).getTime() - 1000);

// Owner / finance: record a stock count (what is on the shelves at the end of
// a day). { day, branchId?, lines: [{ itemId, quantity, unitCost? }], notes }
// Items left out were not counted. One count per branch and day: void the
// wrong one to count again.
Parse.Cloud.define('recordStockCount', async (request) => {
  const { user: actor } = await requireFinance(request);
  const p = request.params || {};
  const { values: config } = await loadConfig();
  const today = isoDay(new Date(), config.timezone);
  const day = p.day ? String(p.day) : today;
  if (!isDay(day) || day > today) throw invalid('Choose a day up to today');
  const branch = p.branchId ? await branchParam(p.branchId) : await branchFor(null);
  if (!Array.isArray(p.lines) || !p.lines.length) throw invalid('Count at least one item');
  if (p.lines.length > 500) throw invalid('A count can have at most 500 items');
  const { byId } = await itemsById();
  const seen = new Set();
  const lines = p.lines.map((line) => {
    const item = byId.get(String(line?.itemId || ''));
    if (!item) throw invalid('Unknown stock item');
    if (seen.has(item.id)) throw invalid(`${item.get('name')} is in the count twice`);
    seen.add(item.id);
    return {
      itemId: item.id,
      name: item.get('name'),
      unit: item.get('unit') || '',
      quantity: quantityOf(line.quantity, item.get('name')),
      unitCost: costOf(line.unitCost ?? item.get('unitCost'), item.get('name')),
    };
  });
  const same = new Parse.Query(COUNT);
  same.equalTo('day', day);
  same.doesNotExist('voidedAt');
  if (branch) same.equalTo('branch', branch);
  else same.doesNotExist('branch');
  if (await same.first(MASTER))
    throw invalid('There is already a count for that day: void it to count again');
  const priced = S.priceCount(lines);
  const row = new Parse.Object(COUNT);
  row.set({
    day,
    countedAt: countedAtOf(day, config),
    lines: priced.lines,
    total: priced.total,
    notes: clean(p.notes, 300),
    countedBy: actor,
    ...(branch && { branch }),
  });
  row.setACL(readAcl(null, ACL_ROLES));
  await row.save(null, MASTER);
  await audit(actor, 'stock.counted', row, null, {
    day,
    items: priced.lines.length,
    total: priced.total,
  });
  // Low in this branch after this count (its own reorder levels): tell the
  // owner once.
  const low = priced.lines.filter((line) => {
    const item = byId.get(line.itemId);
    return S.isLow(
      { reorderLevel: item.get('reorderLevel'), reorderLevels: item.get('reorderLevels') },
      line.quantity,
      branch?.id || '',
    );
  });
  if (low.length) {
    const { notifyAdmins } = require('./notifications');
    const where =
      branch?.get('name') && (await branchList()).length > 1 ? ` at ${branch.get('name')}` : '';
    await notifyAdmins({
      kind: 'stock_low',
      tone: 'warning',
      title: `${low.length} stock item${low.length === 1 ? '' : 's'} low${where}`,
      body: low
        .slice(0, 6)
        .map((line) => `${line.name}: ${line.quantity} ${line.unit}`.trim())
        .join(', '),
      link: '/admin/spending?tab=stock',
      key: `stock-low:${row.id}`,
    });
  }
  row.set('countedBy', await actor.fetch(MASTER));
  return { ...countView(row), low: low.map((line) => line.itemId) };
});

// Owner / finance: void a wrong count. { id, reason }
Parse.Cloud.define('voidStockCount', async (request) => {
  const { user: actor } = await requireFinance(request);
  const reason = clean(request.params.reason, 200);
  if (reason.length < 3) throw invalid('Say why it is being voided');
  const row = await new Parse.Query(COUNT)
    .get(String(request.params.id || ''), MASTER)
    .catch(() => null);
  if (!row) throw invalid('Not found');
  if (row.get('voidedAt')) throw invalid('Already voided');
  row.set({ voidedAt: new Date(), voidReason: reason, voidedBy: actor });
  await row.save(null, MASTER);
  await audit(actor, 'stock.count_voided', row, { voided: false }, { voided: true, reason });
  return countView(row);
});

// Purchase lines naming a stock item (spending.js): checks the items, fills
// the unit, and makes the item's cost per unit follow the purchase.
// → { lines, linked } (linked: some line names an item).
async function linkPurchaseLines(lines, raw, day) {
  const ids = raw.map((line) => (line && line.itemId ? String(line.itemId) : ''));
  if (!ids.some(Boolean)) return { lines, linked: false };
  const { byId } = await itemsById();
  const touched = new Map();
  const out = lines.map((line, i) => {
    if (!ids[i]) return line;
    const item = byId.get(ids[i]);
    if (!item) throw invalid(`${line.description}: unknown stock item`);
    touched.set(item.id, { item, unitCost: line.unitCost });
    return { ...line, itemId: item.id, unit: line.unit || item.get('unit') || '' };
  });
  const changed = [];
  for (const { item, unitCost } of touched.values()) {
    const last = item.get('lastBoughtDay') || '';
    if (day < last) continue;
    item.set({ unitCost, lastBoughtDay: day, lastBoughtAt: new Date() });
    changed.push(item);
  }
  if (changed.length) await Parse.Object.saveAll(changed, MASTER);
  return { lines: out, linked: true };
}

// Stock counts for the accounts (accounting.js): { branch, at, total }.
const countsFor = (branch, end) => countRows(branch, end);

module.exports = { linkPurchaseLines, countsFor, ITEM, COUNT };
