// Branches (Admin → Branches): the restaurant's outlets. Every order, shift,
// cash handover and till payout carries its branch, and each rider or
// cashier works at one. The owner and finance see every branch; reports
// filter by branch.
//
// A restaurant starts with no branches and nothing changes for it. The first
// time the owner opens Branches, the "Main branch" is made and every existing
// record and team member is put in it, so from then on every row has a
// branch and filters are a plain equalTo.

const {
  MASTER,
  invalid,
  forbidden,
  requireRole,
  adminOnly,
  audit,
  findAll,
  claimOnce,
  readAcl,
} = require('./lib/core');
const { cleanLocation, pinOf } = require('./lib/geo');

const CLASS = 'Branch';
// Records that belong to a branch.
const TAGGED = ['Order', 'Shift', 'CashHandover', 'TillPayout'];
const ROLES = ['admin', 'finance', 'cashier', 'rider'];

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const ID = /^[A-Za-z0-9]{1,32}$/;

async function allBranches() {
  const rows = await findAll(new Parse.Query(CLASS));
  return rows.sort(
    (a, b) =>
      Number(a.get('sortOrder') || 0) - Number(b.get('sortOrder') || 0) ||
      a.createdAt - b.createdAt,
  );
}

// The main branch, or null while the restaurant has no branches.
async function mainBranch() {
  return new Parse.Query(CLASS).equalTo('main', true).first(MASTER);
}

// Pointer columns for the tagged classes and team members (Postgres needs
// them before anything can be filtered on them).
async function ensureColumns() {
  const existing = new Map((await Parse.Schema.all()).map((s) => [s.className, s]));
  for (const className of [...TAGGED, '_User']) {
    const current = existing.get(className);
    if (!current || current.fields?.branch) continue;
    const schema = new Parse.Schema(className);
    schema.addPointer('branch', CLASS);
    await schema.update().catch(() => undefined);
  }
}

// Puts every record and team member without a branch into `branch`.
async function backfill(branch) {
  const counts = {};
  for (const className of [...TAGGED, '_User']) {
    const query = new Parse.Query(className);
    query.doesNotExist('branch');
    let count = 0;
    await query.each(
      async (row) => {
        row.set('branch', branch);
        await row.save(null, MASTER);
        count += 1;
      },
      { ...MASTER, batchSize: 200 },
    );
    counts[className] = count;
  }
  return counts;
}

// The main branch, made (with everything put in it) the first time.
async function ensureMainBranch(actor) {
  let main = await mainBranch();
  if (main) return main;
  if (await claimOnce('branch:main')) {
    main = new Parse.Object(CLASS);
    main.set({
      name: 'Main branch',
      address: '',
      phone: '',
      active: true,
      main: true,
      sortOrder: 0,
    });
    main.setACL(readAcl(null, ROLES));
    await main.save(null, MASTER);
    await ensureColumns();
    const moved = await backfill(main);
    await audit(actor, 'branch.created', main, null, { name: 'Main branch', main: true, moved });
    return main;
  }
  // Someone else is making it right now.
  for (let i = 0; i < 50 && !main; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    main = await mainBranch();
  }
  if (!main) throw invalid('Branches are being set up. Try again in a moment');
  return main;
}

// The branch a member's new records go in: their own, else the main one;
// null while the restaurant has no branches.
async function branchFor(user) {
  if (!user) return mainBranch();
  const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER).catch(() => null);
  const own = fresh?.get('branch');
  if (own) return own;
  return mainBranch();
}

// A branch the caller asked for by id (reports, assignments), or null for
// "every branch". Unknown ids are refused.
async function branchParam(id) {
  if (id === undefined || id === null || id === '' || id === 'all') return null;
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('Unknown branch');
  const branch = await new Parse.Query(CLASS).get(id, MASTER).catch(() => null);
  if (!branch) throw invalid('Unknown branch');
  return branch;
}

// Limits a query on a tagged class to one branch (no-op for all branches).
function inBranch(query, branch) {
  if (branch) query.equalTo('branch', branch);
  return query;
}

const view = (row, members = {}) => ({
  id: row.id,
  name: row.get('name'),
  address: row.get('address') || '',
  phone: row.get('phone') || '',
  active: row.get('active') !== false,
  main: row.get('main') === true,
  // Its pin on the map: maps for its staff open here, and online
  // deliveries are priced from it (online.js).
  location: pinOf(row.get('lat'), row.get('lng')),
  members: members[row.id] || { riders: 0, cashiers: 0 },
});

// Staff: the branches, for filters and pickers. Riders and cashiers only see
// their own.
Parse.Cloud.define('getBranches', async (request) => {
  const { user, role } = await requireRole(request, ROLES);
  // The owner may give team members a branch before ever opening Branches.
  if (role === 'admin') await ensureMainBranch(user);
  const rows = await allBranches();
  if (['admin', 'finance'].includes(role)) return { branches: rows.map((row) => view(row)) };
  const own = (await branchFor(user))?.id;
  return { branches: rows.filter((row) => row.id === own).map((row) => view(row)) };
});

// Owner: the branches with how many riders and cashiers each has. Opening it
// the first time makes the main branch.
Parse.Cloud.define('adminListBranches', async (request) => {
  const actor = await adminOnly(request);
  await ensureMainBranch(actor);
  const rows = await allBranches();
  const members = {};
  for (const role of ['rider', 'cashier']) {
    const roleRow = await new Parse.Query(Parse.Role).equalTo('name', role).first(MASTER);
    if (!roleRow) continue;
    for (const user of await findAll(roleRow.getUsers().query())) {
      if (user.get('active') === false) continue;
      const id = user.get('branch')?.id;
      if (!id) continue;
      members[id] ||= { riders: 0, cashiers: 0 };
      members[id][role === 'rider' ? 'riders' : 'cashiers'] += 1;
    }
  }
  return { branches: rows.map((row) => view(row, members)) };
});

// Owner: add or edit a branch. { id?, name, address, phone, active, location? }
// (location: { lat, lng }, or null to remove the pin)
Parse.Cloud.define('adminSaveBranch', async (request) => {
  const actor = await adminOnly(request);
  const p = request.params;
  await ensureMainBranch(actor);
  const name = clean(p.name, 60);
  if (name.length < 2) throw invalid('Give the branch a name');
  const rows = await allBranches();
  if (rows.some((row) => row.id !== p.id && row.get('name').toLowerCase() === name.toLowerCase()))
    throw invalid(`There is already a branch called "${name}"`);
  const row = p.id ? rows.find((r) => r.id === p.id) : new Parse.Object(CLASS);
  if (!row) throw invalid('Unknown branch');
  const before = p.id ? view(row) : null;
  const active = p.active === undefined ? row.get('active') !== false : p.active === true;
  if (!active && row.get('main')) throw forbidden('The main branch cannot be closed');
  if (!active && row.get('active') !== false) {
    const staff = await new Parse.Query(Parse.User)
      .equalTo('branch', row)
      .notEqualTo('active', false)
      .count(MASTER);
    if (staff) throw invalid(`Move its ${staff} team member(s) to another branch first`);
  }
  if (!p.id) await require('./lib/limits').checkBranchLimit(rows.length + 1);
  if ('location' in p) {
    const pin = cleanLocation(p.location);
    if (pin.error) throw invalid(pin.error);
    if (pin.location) row.set({ lat: pin.location.lat, lng: pin.location.lng });
    else {
      row.unset('lat');
      row.unset('lng');
    }
  }
  row.set({
    name,
    address: clean(p.address, 200),
    phone: clean(p.phone, 30),
    active,
    main: row.get('main') === true,
    sortOrder: p.id ? row.get('sortOrder') || 0 : rows.length,
  });
  row.setACL(readAcl(null, ROLES));
  await row.save(null, MASTER);
  await audit(actor, p.id ? 'branch.updated' : 'branch.created', row, before, view(row));
  return view(row);
});

// A member's branch when the owner sets it (adminCreateTeamMember,
// adminUpdateMember): must be an open branch.
async function assignableBranch(id, actor) {
  const branch = id ? await branchParam(id) : await ensureMainBranch(actor);
  if (branch.get('active') === false) throw invalid('That branch is closed');
  return branch;
}

module.exports = {
  mainBranch,
  ensureMainBranch,
  branchFor,
  branchParam,
  inBranch,
  assignableBranch,
  backfill,
  TAGGED,
};
