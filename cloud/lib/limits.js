// Relay Hosted: each restaurant's plan decides how many branches and team
// members it may have and which parts of the app it has (docs/HOSTED.md).
//
// Basic: one branch, up to 2 cashiers and 5 riders, no finance role, no
//   purchases/expenses/accounting and no Reports analytics (the Z-report
//   stays).
// Enterprise: everything, no limits.
//
// Limits are checked when something is added (a branch, a member, a role
// change, a member switched back on); what a restaurant already has is
// never taken away. Outside a restaurant (platform console, jobs) nothing
// is limited.

const PLANS = {
  basic: {
    label: 'Basic',
    branches: 1,
    members: { cashier: 2, rider: 5, finance: 0 },
    features: { branches: false, finance: false, accounting: false, reports: false },
  },
  enterprise: {
    label: 'Enterprise',
    branches: Infinity,
    members: {},
    features: { branches: true, finance: true, accounting: true, reports: true },
  },
};
const MASTER = { useMasterKey: true };

const planOf = (row) => (row?.get('plan') === 'enterprise' ? 'enterprise' : 'basic');

async function currentRow() {
  const tenancy = require('./tenant');
  const tenant = tenancy.current();
  if (!tenant) return null;
  return tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(tenant, MASTER).catch(() => null),
  );
}

async function currentPlan() {
  const row = await currentRow();
  return row ? PLANS[planOf(row)] : PLANS.enterprise;
}

const refuse = (message) =>
  new Parse.Error(
    Parse.Error.OPERATION_FORBIDDEN,
    `${message} Upgrade to Enterprise in Subscription to add more.`,
  );

async function checkBranchLimit(count) {
  const plan = await currentPlan();
  if (count > plan.branches)
    throw refuse(
      `The ${plan.label} plan has ${plan.branches} branch${plan.branches === 1 ? '' : 'es'}.`,
    );
}

// Active members holding `role` in this restaurant (role queries and user
// queries are scoped to the restaurant by lib/tenant.js).
async function activeMembers(role) {
  const roleRow = await new Parse.Query(Parse.Role).equalTo('name', role).first(MASTER);
  if (!roleRow) return 0;
  const users = roleRow.getUsers().query();
  users.notEqualTo('active', false);
  return users.count(MASTER);
}

// Before someone becomes an active `role`.
async function checkMemberLimit(role) {
  const plan = await currentPlan();
  const max = plan.members[role];
  if (max === undefined) return;
  if (max === 0) throw refuse(`The ${plan.label} plan has no ${role} role.`);
  if ((await activeMembers(role)) >= max)
    throw refuse(`The ${plan.label} plan allows ${max} ${role}s.`);
}

async function features() {
  return { ...(await currentPlan()).features };
}

// What stops a restaurant moving to `plan` (a downgrade): what it has over
// that plan's limits. Empty when it fits.
async function overLimits(plan) {
  const target = PLANS[plan];
  const problems = [];
  const branches = await new Parse.Query('Branch').notEqualTo('active', false).count(MASTER);
  if (branches > target.branches)
    problems.push(`${branches} open branches (${target.branches} allowed)`);
  for (const [role, max] of Object.entries(target.members)) {
    const count = await activeMembers(role);
    if (count > max) problems.push(`${count} active ${role}s (${max} allowed)`);
  }
  return problems;
}

module.exports = { PLANS, planOf, checkBranchLimit, checkMemberLimit, features, overLimits };
