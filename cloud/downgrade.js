// Relay Hosted: moving down to a smaller plan (billing.js → changePlan).
//
// When the restaurant has more than the smaller plan allows, the owner picks
// what stays: the branches (up to the plan's number) and, per limited role,
// the team members. The choice is saved with the scheduled move
// (Restaurant.nextPlanKeep) and applied when the paid period ends: the other
// branches are closed, and the team members outside the kept branches or
// beyond the limits are deactivated (and signed out). Nothing is deleted:
// orders, payments, shifts and handovers of every branch stay and remain in
// reports and ledgers; a closed branch or member can be reopened after moving
// up again.

const { MASTER, invalid, audit, claimOnce, endSessions, findAll } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { log } = require('./lib/log');

const LIMITED_ROLES = ['cashier', 'rider', 'finance'];
const ROLE_NAMES = { cashier: 'cashiers', rider: 'riders', finance: 'finance staff' };

// Active team members with a limited role (run inside the restaurant).
async function teamByRole() {
  const out = {};
  for (const role of LIMITED_ROLES) {
    out[role] = [];
    const roleRow = await new Parse.Query(Parse.Role).equalTo('name', role).first(MASTER);
    if (!roleRow) continue;
    for (const user of await findAll(roleRow.getUsers().query())) {
      if (user.get('active') === false) continue;
      out[role].push(user);
    }
  }
  return out;
}

async function openBranches() {
  return (await findAll(new Parse.Query('Branch')))
    .filter((row) => row.get('active') !== false)
    .sort((a, b) => Number(b.get('main') === true) - Number(a.get('main') === true));
}

// What moving to `plan` asks the owner to choose (run inside the
// restaurant). `fits`: nothing to choose.
async function downgradeChoices(plan) {
  const branches = await openBranches();
  const team = await teamByRole();
  const maxBranches = plan.limits.branches;
  const branchesOver = typeof maxBranches === 'number' && branches.length > maxBranches;
  const roles = {};
  let rolesOver = false;
  for (const role of LIMITED_ROLES) {
    const max = plan.limits[role];
    const members = team[role];
    const over = typeof max === 'number' && members.length > max;
    rolesOver ||= over;
    roles[role] = {
      max: typeof max === 'number' ? max : null,
      members: members.map((user) => ({
        id: user.id,
        name: user.get('name') || tenancy.displayUsername(user.getUsername()),
        username: tenancy.displayUsername(user.getUsername()),
        branchId: user.get('branch')?.id || '',
      })),
    };
  }
  return {
    plan: plan.key,
    planName: plan.name,
    // Branches decide which members can stay, so they matter whenever there
    // is more than one and members are limited, too.
    fits: !branchesOver && !rolesOver,
    maxBranches: typeof maxBranches === 'number' ? maxBranches : null,
    branches: branches.map((row) => ({
      id: row.id,
      name: row.get('name'),
      main: row.get('main') === true,
    })),
    roles,
  };
}

// Checks the owner's choice { branches: [ids], members: [ids] } against the
// plan; returns the cleaned choice. Members of a limited role must work in a
// kept branch (or in none).
function checkKeep(choices, keep) {
  const branchIds = new Set(choices.branches.map((b) => b.id));
  const keptBranches = [...new Set((keep?.branches || []).map(String))].filter((id) =>
    branchIds.has(id),
  );
  if (choices.branches.length && !keptBranches.length)
    throw invalid('Choose the branch to keep open');
  if (choices.maxBranches !== null && keptBranches.length > choices.maxBranches)
    throw invalid(
      `${choices.planName} allows ${choices.maxBranches} branch${choices.maxBranches === 1 ? '' : 'es'}`,
    );
  const kept = new Set(keptBranches);
  const wanted = new Set((keep?.members || []).map(String));
  const members = [];
  for (const role of LIMITED_ROLES) {
    const { max, members: list } = choices.roles[role];
    const eligible = list.filter((m) => !m.branchId || kept.has(m.branchId) || !branchIds.size);
    const chosen = max === null ? eligible : eligible.filter((member) => wanted.has(member.id));
    if (max !== null && chosen.length > max)
      throw invalid(`${choices.planName} allows ${max} ${ROLE_NAMES[role]}: choose ${max}`);
    members.push(...chosen.map((m) => m.id));
  }
  return { branches: keptBranches, members };
}

// The choice made for the restaurant when the owner made none (it fitted
// when the move was chosen, or staff were added since): the main branch
// first, and the longest-serving members.
function defaultKeep(choices) {
  const branches = choices.branches
    .slice(0, choices.maxBranches ?? choices.branches.length)
    .map((b) => b.id);
  const kept = new Set(branches);
  const members = [];
  for (const role of LIMITED_ROLES) {
    const { max, members: list } = choices.roles[role];
    const eligible = list.filter((m) => !m.branchId || kept.has(m.branchId) || !kept.size);
    members.push(...(max === null ? eligible : eligible.slice(0, max)).map((m) => m.id));
  }
  return { branches, members };
}

// Applies a move whose date has come: the plan changes and what was not kept
// is closed or deactivated. Once per restaurant and date; best effort.
async function applyDueDowngrade(restaurantId) {
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(restaurantId, MASTER).catch(() => null),
  );
  const next = row?.get('nextPlan');
  const from = row?.get('nextPlanFrom');
  if (!next || !(from instanceof Date) || from.getTime() > Date.now()) return false;
  if (!(await tenancy.withoutTenant(() => claimOnce(`downgrade:${row.id}:${from.toISOString()}`))))
    return false;
  try {
    const { values: platform } = await require('./restaurants').platformSettings();
    const plan = require('./lib/plans').planFor(platform.plans || [], next);
    const result = await tenancy.runAs(
      row.id,
      async () => {
        const choices = await downgradeChoices(plan);
        let keep;
        try {
          keep = checkKeep(choices, row.get('nextPlanKeep') || defaultKeep(choices));
        } catch {
          keep = defaultKeep(choices);
        }
        const keptBranches = new Set(keep.branches);
        const keptMembers = new Set(keep.members);
        const closed = [];
        const branches = await openBranches();
        // The main branch moves to a kept branch when it is not kept.
        const mainKept = branches.some((b) => b.get('main') === true && keptBranches.has(b.id));
        for (const branch of branches) {
          if (!keptBranches.size || keptBranches.has(branch.id)) {
            if (!mainKept && branch.id === keep.branches[0]) {
              branch.set('main', true);
              await branch.save(null, MASTER);
            }
            continue;
          }
          branch.set({ active: false, main: false });
          await branch.save(null, MASTER);
          closed.push(branch.get('name'));
        }
        const team = await teamByRole();
        const deactivated = [];
        for (const role of LIMITED_ROLES)
          for (const user of team[role]) {
            if (keptMembers.has(user.id)) continue;
            user.set('active', false);
            await user.save(null, MASTER);
            await endSessions(user);
            deactivated.push(user.get('name') || tenancy.displayUsername(user.getUsername()));
          }
        await audit(null, 'subscription.downgraded', row, null, {
          plan: plan.key,
          closedBranches: closed,
          deactivated,
        });
        await require('./notifications').notifyAdmins({
          kind: 'billing.plan_changed',
          tone: 'info',
          title: `You are now on ${plan.name}`,
          body: [
            closed.length ? `Closed: ${closed.join(', ')}.` : '',
            deactivated.length ? `Deactivated: ${deactivated.join(', ')}.` : '',
            'Their orders and payments stay in your reports.',
          ]
            .filter(Boolean)
            .join(' '),
          link: '/admin/site/billing',
          key: `downgrade:${from.toISOString()}`,
        });
        return { closed, deactivated };
      },
      row.get('code'),
    );
    row.set('plan', next);
    row.unset('nextPlan');
    row.unset('nextPlanFrom');
    row.unset('nextPlanKeep');
    await tenancy.withoutTenant(() => row.save(null, MASTER));
    tenancy.clearCache();
    log('info', 'billing.downgraded', { restaurant: row.id, plan: next, ...result });
    return true;
  } catch (error) {
    log('error', 'billing.downgrade_failed', {
      restaurant: row.id,
      message: String(error?.message),
    });
    return false;
  }
}

// Owner: what moving down to { plan } would ask to choose.
Parse.Cloud.define('getDowngradeChoices', async (request) => {
  const { requireRole } = require('./lib/core');
  await requireRole(request, ['admin']);
  const { values: platform } = await require('./restaurants').platformSettings();
  const plan = platform.plans.find((x) => x.active && x.key === request.params?.plan);
  if (!plan) throw invalid('Choose one of the plans on offer');
  return downgradeChoices(plan);
});

module.exports = { downgradeChoices, checkKeep, defaultKeep, applyDueDowngrade };
