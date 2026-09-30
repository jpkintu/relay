// Plan limits: how many branches and team members a restaurant may have, and
// which parts of the app it has. The single-restaurant edition has no
// limits; Relay Hosted replaces these with the restaurant's plan.

async function checkBranchLimit() {}

// role: the role a member is about to take (created, moved or reactivated).
async function checkMemberLimit() {}

// Parts of the app switched on for this restaurant.
async function features() {
  return { branches: true, finance: true, accounting: true };
}

module.exports = { checkBranchLimit, checkMemberLimit, features };
