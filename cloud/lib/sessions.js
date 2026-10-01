// How long a sign-in lasts (S7, docs/ROADMAP.md §5). Parse Server's own
// `sessionLength` (server options) ends every session after 30 days; this
// ends the owner's and finance sessions sooner, and holds every session to
// its limit even where the server option is not set. Checked on each Cloud
// function call (errors.js), cached briefly per session.

const DAY = 86400000;

// Days a session lasts, by role.
function sessionDays(role) {
  const staff = Number(process.env.RELAY_SESSION_DAYS || 30);
  const owner = Number(process.env.RELAY_ADMIN_SESSION_DAYS || 14);
  // Relay Hosted: platform staff, who reach every restaurant.
  if (role === 'platform')
    return Math.min(Number(process.env.RELAY_PLATFORM_SESSION_DAYS || 1), staff);
  return role === 'admin' || role === 'finance' ? Math.min(owner, staff) : staff;
}

// Whether a session made at `createdAt` has run out for `role`.
const expired = (createdAt, role, now = Date.now()) =>
  now - new Date(createdAt).getTime() > sessionDays(role) * DAY;

const cache = new Map();
const CACHE_MS = 5 * 60000;

// Throws "session ended" (and deletes the session) when it has run out.
async function checkSession(request) {
  const user = request.user;
  const token = user?.getSessionToken?.();
  if (!token || request.master) return;
  let entry = cache.get(token);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const { MASTER, getRoleName } = require('./core');
    const session = await new Parse.Query(Parse.Session)
      .equalTo('sessionToken', token)
      .first(MASTER);
    if (!session) return;
    entry = {
      createdAt: session.createdAt,
      // Relay Hosted: an account of no restaurant is platform staff.
      role: user.get('tenant') ? await getRoleName(user) : 'platform',
      session,
      at: Date.now(),
    };
    cache.set(token, entry);
    if (cache.size > 5000) cache.clear();
  }
  if (!expired(entry.createdAt, entry.role)) return;
  cache.delete(token);
  if (entry.session) await entry.session.destroy({ useMasterKey: true }).catch(() => undefined);
  throw new Parse.Error(
    Parse.Error.INVALID_SESSION_TOKEN,
    'Your sign-in has expired. Sign in again.',
  );
}

module.exports = { sessionDays, expired, checkSession, DAY };
