// Plan limits: how many branches and team members a restaurant may have, and
// which parts of the app it has. The single-restaurant edition has no
// limits; Relay Hosted replaces these with the restaurant's plan.

async function checkBranchLimit() {}

// role: the role a member is about to take (created, moved or reactivated).
async function checkMemberLimit() {}

// Parts of the app switched on for this restaurant.
async function features() {
  // branches: more than one; finance: the finance role; accounting:
  // purchases, expenses and the statements; reports: the Reports analytics
  // (the Z-report is always there).
  // efris: EFRIS fiscal receipts; whatsapp: WhatsApp daily summaries.
  return {
    branches: true,
    finance: true,
    accounting: true,
    reports: true,
    efris: true,
    whatsapp: true,
  };
}

module.exports = { checkBranchLimit, checkMemberLimit, features };
