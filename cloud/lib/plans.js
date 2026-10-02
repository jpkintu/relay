// Relay Hosted: the plans restaurants subscribe to (docs/HOSTED.md → Plans).
// Platform staff create and change them in the platform console: the price,
// how many branches and team members of each role, and which parts of the
// app are included. They live in the Plan class (Relay's own, not any
// restaurant's) and are cached briefly.
//
// The first time plans are needed, Basic and Enterprise are made from the
// platform settings' prices (owner's decision 2026-09-30).

const MASTER = { useMasterKey: true };

// Parts of the app a plan can include (the app and the server check them
// through lib/limits.js → features()).
const FEATURES = ['branches', 'finance', 'accounting', 'reports', 'efris', 'whatsapp'];
// Limits per role and branches; null = no limit.
const LIMITS = ['branches', 'cashier', 'rider', 'finance'];

// Paying a year at once costs this many months by default (two months free);
// platform staff can set each plan's annual price.
const ANNUAL_MONTHS = 10;
const annualOf = (price, annual) =>
  typeof annual === 'number' && annual >= 0 ? annual : price * ANNUAL_MONTHS;

const DEFAULTS = [
  {
    key: 'basic',
    name: 'Basic',
    description: 'One outlet: orders, kitchen, cash and the Z-report',
    priceField: 'monthlyPrice',
    limits: { branches: 1, cashier: 2, rider: 5, finance: 0 },
    features: {
      branches: false,
      finance: false,
      accounting: false,
      reports: false,
      efris: true,
      whatsapp: true,
    },
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited branches and team, with finance, accounting, stock and reports',
    priceField: 'enterprisePrice',
    limits: { branches: null, cashier: null, rider: null, finance: null },
    features: Object.fromEntries(FEATURES.map((f) => [f, true])),
  },
];

const withoutTenant = (fn) => require('./tenant').withoutTenant(fn);

function view(row) {
  const limits = row.get('limits') || {};
  const features = row.get('features') || {};
  return {
    id: row.id,
    key: row.get('key'),
    name: row.get('name'),
    description: row.get('description') || '',
    price: Number(row.get('price') || 0),
    // A year paid at once (null when not set: ANNUAL_MONTHS × price).
    annualPrice: annualOf(Number(row.get('price') || 0), row.get('annualPrice')),
    annualSet: typeof row.get('annualPrice') === 'number',
    active: row.get('active') !== false,
    sortOrder: Number(row.get('sortOrder') || 0),
    limits: Object.fromEntries(
      LIMITS.map((k) => [k, typeof limits[k] === 'number' && limits[k] >= 0 ? limits[k] : null]),
    ),
    features: Object.fromEntries(FEATURES.map((f) => [f, features[f] !== false])),
  };
}

async function seed(platform) {
  const rows = DEFAULTS.map((plan, index) => {
    const row = new Parse.Object('Plan');
    row.set({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      price: Math.round(Number(platform[plan.priceField]) || 0),
      limits: plan.limits,
      features: plan.features,
      active: true,
      sortOrder: index,
    });
    row.setACL(new Parse.ACL());
    return row;
  });
  await withoutTenant(() => Parse.Object.saveAll(rows, MASTER));
  return rows;
}

let cache = null;
// Every plan (active or not), in order. `platform`: the platform settings
// (for the prices of the first two plans).
async function loadPlans(platform, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30000) return cache.plans;
  let rows = await withoutTenant(() => new Parse.Query('Plan').limit(200).find(MASTER));
  if (!rows.length) {
    const { claimOnce } = require('./core');
    if (await withoutTenant(() => claimOnce('platform:plans:seed'))) rows = await seed(platform);
    else
      for (let i = 0; i < 50 && !rows.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        rows = await withoutTenant(() => new Parse.Query('Plan').limit(200).find(MASTER));
      }
  }
  const plans = rows
    .map(view)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  cache = { plans, at: Date.now() };
  return plans;
}
const clearPlans = () => {
  cache = null;
};

// The plan a restaurant is on: its own key, else the first plan offered.
function planFor(plans, key) {
  return (
    plans.find((plan) => plan.key === key) ||
    plans.find((plan) => plan.active) ||
    plans[0] || { key: 'none', name: 'None', price: 0, limits: {}, features: {} }
  );
}

module.exports = {
  FEATURES,
  LIMITS,
  ANNUAL_MONTHS,
  annualOf,
  loadPlans,
  clearPlans,
  planFor,
  view,
};
