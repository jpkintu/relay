// The cash drawer at the counter (docs/ROADMAP.md → Cash drawer).
//
// The drawer itself is opened by the till device (src/lib/drawer.ts): through
// the receipt printer's driver, a USB or serial printer from the browser, or
// a network printer through the Relay print bridge. The server keeps the
// owner's settings (Configuration.cashDrawer…) and a record of every opening:
// on the cashier's shift (drawerOpens, noSaleOpens) and in the audit log.
// Opening it without a sale needs the PIN and a reason, and tells the owner.

const {
  MASTER,
  invalid,
  requireRole,
  audit,
  loadConfig,
  verifyPin,
  personName,
  findAll,
} = require('./lib/core');
const { notifyAdmins } = require('./notifications');
const { resolveRange } = require('./lib/dates');

// Why the drawer opened.
const REASONS = {
  sale: 'Cash sale',
  payment: 'Bill paid in cash',
  handover: 'Cash handover counted in',
  payout: 'Paid out of the till',
  shift: 'Opening count',
  no_sale: 'No sale',
};

async function openShiftOf(user) {
  return new Parse.Query('Shift')
    .equalTo('operator', user)
    .equalTo('kind', 'cashier')
    .equalTo('status', 'open')
    .first(MASTER);
}

// Cashier (or the owner at the till): the drawer was opened.
// { reason, ref?, note?, pin? }. A no-sale opening needs the PIN and a note.
Parse.Cloud.define('logDrawerOpen', async (request) => {
  const { user, role } = await requireRole(request, ['cashier', 'admin']);
  const p = request.params || {};
  const reason = String(p.reason || '');
  if (!REASONS[reason]) throw invalid('Unknown reason for opening the drawer');
  const { values: config } = await loadConfig();
  if (config.cashDrawer !== true) throw invalid('The cash drawer is switched off in Settings');
  const note = String(p.note || '')
    .trim()
    .slice(0, 200);
  if (reason === 'no_sale') {
    if (note.length < 3) throw invalid('Say why the drawer is opened');
    await verifyPin(user, p.pin);
  }
  const shift = role === 'cashier' ? await openShiftOf(user) : null;
  if (reason === 'no_sale' && role === 'cashier' && !shift) throw invalid('Start your shift first');
  if (shift) {
    shift.increment('drawerOpens');
    if (reason === 'no_sale') shift.increment('noSaleOpens');
    await shift.save(null, MASTER);
  }
  const ref = /^[A-Za-z0-9]{1,32}$/.test(String(p.ref || '')) ? String(p.ref) : '';
  await audit(user, 'till.drawer_opened', shift || user, null, {
    reason,
    label: REASONS[reason],
    ref,
    note,
  });
  if (reason === 'no_sale')
    await notifyAdmins({
      kind: 'till.no_sale',
      tone: 'warning',
      title: 'Cash drawer opened without a sale',
      body: `${personName(await user.fetch(MASTER))}: ${note}`,
      link: '/admin/audit',
    });
  return {
    opened: true,
    drawerOpens: shift?.get('drawerOpens') || 0,
    noSaleOpens: shift?.get('noSaleOpens') || 0,
  };
});

// Owner and finance: drawer openings in a period, newest first, with the
// count per cashier. { range?, from?, to? } as the reports take them.
Parse.Cloud.define('getDrawerOpenings', async (request) => {
  const { branch } = await requireRole(request, ['admin', 'finance']);
  const { values: config } = await loadConfig();
  const range = resolveRange(request.params || {}, config.timezone);
  if (range.error) throw invalid(range.error);
  const { start, end } = range;
  const query = new Parse.Query('AuditLog');
  query.equalTo('action', 'till.drawer_opened');
  query.greaterThanOrEqualTo('createdAt', start);
  query.lessThan('createdAt', end);
  query.include('actor');
  // Newest first (findAll cannot sort). A branch finance officer sees the
  // drawers opened by that branch's cashiers.
  const rows = (await findAll(query))
    .filter((row) => !branch || row.get('actor')?.get('branch')?.id === branch.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const people = {};
  const items = rows.map((row) => {
    const after = JSON.parse(row.get('afterJson') || '{}');
    const actor = row.get('actor');
    const name = actor ? personName(actor) : '';
    people[name] ||= { name, opens: 0, noSale: 0 };
    people[name].opens += 1;
    if (after.reason === 'no_sale') people[name].noSale += 1;
    return {
      at: row.createdAt.toISOString(),
      by: name,
      reason: after.reason,
      label: after.label || REASONS[after.reason] || after.reason,
      note: after.note || '',
      ref: after.ref || '',
    };
  });
  return { items, people: Object.values(people).sort((a, b) => b.opens - a.opens) };
});

module.exports = { REASONS };
