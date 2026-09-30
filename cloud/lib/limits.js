// Relay Hosted: each restaurant's plan decides how many branches and team
// members it may have and which parts of the app it has (docs/HOSTED.md →
// Plans). The plans themselves are set by platform staff (lib/plans.js).
//
// Limits are checked when something is added (a branch, a member, a role
// change, a member switched back on); what a restaurant already has is
// never taken away. Outside a restaurant (platform console, jobs) nothing
// is limited.

const { loadPlans, planFor } = require('./plans');

const MASTER = { useMasterKey: true };
const ALL = {
  branches: true,
  finance: true,
  accounting: true,
  reports: true,
  efris: true,
  whatsapp: true,
};

const planOf = (row) => row?.get('plan') || '';

async function platformValues() {
  return (await require('../restaurants').platformSettings()).values;
}

// This restaurant's plan (null outside a restaurant).
async function currentPlan() {
  const tenancy = require('./tenant');
  const tenant = tenancy.current();
  if (!tenant) return null;
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').get(tenant, MASTER).catch(() => null),
  );
  if (!row) return null;
  return planFor(await loadPlans(await platformValues()), planOf(row));
}

const refuse = (message) =>
  new Parse.Error(
    Parse.Error.OPERATION_FORBIDDEN,
    `${message} Move to a bigger plan in Subscription → Plans to add more.`,
  );

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('h') ? 'es' : 's'}`;

async function checkBranchLimit(count) {
  const plan = await currentPlan();
  const max = plan?.limits.branches;
  if (typeof max === 'number' && count > max)
    throw refuse(`The ${plan.name} plan has ${plural(max, 'branch')}.`);
}

// Active members holding `role` in this restaurant (role and user queries
// are scoped to the restaurant by lib/tenant.js).
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
  const max = plan?.limits[role];
  if (typeof max !== 'number') return;
  if (max === 0) throw refuse(`The ${plan.name} plan has no ${role} role.`);
  if ((await activeMembers(role)) >= max)
    throw refuse(`The ${plan.name} plan allows ${plural(max, role)}.`);
}

async function features() {
  const plan = await currentPlan();
  return plan ? { ...ALL, ...plan.features } : { ...ALL };
}

// What stops this restaurant moving to `plan`: what it has over that plan's
// limits. Empty when it fits.
async function overLimits(plan) {
  const problems = [];
  const max = plan.limits.branches;
  if (typeof max === 'number') {
    const branches = await new Parse.Query('Branch').notEqualTo('active', false).count(MASTER);
    if (branches > max) problems.push(`${branches} open branches (${max} allowed)`);
  }
  for (const role of ['cashier', 'rider', 'finance']) {
    const limit = plan.limits[role];
    if (typeof limit !== 'number') continue;
    const count = await activeMembers(role);
    if (count > limit) problems.push(`${count} active ${role}s (${limit} allowed)`);
  }
  return problems;
}

module.exports = { planOf, currentPlan, checkBranchLimit, checkMemberLimit, features, overLimits };
