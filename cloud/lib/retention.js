// Relay Hosted: when a restaurant that stopped paying has its data deleted
// (purge.js). Worked out from its dates each time, like its access
// (lib/access.js).
//
// The app closes at the end of the trial or the paid period plus the grace
// days. `deleteAfterDays` after that, its records are deleted; the owner is
// emailed `deleteWarnDays` before. A restaurant is never deleted sooner than
// `deleteWarnDays` after its warning, so one found late still gets the full
// notice. Paying (or the platform extending its dates) stops it.

const { accessOf } = require('./access');

const DAY = 86400000;
const DEFAULTS = { deleteAfterDays: 30, deleteWarnDays: 3 };

const settingsOf = (platform = {}) => ({
  deleteAfterDays: Number(platform.deleteAfterDays ?? DEFAULTS.deleteAfterDays),
  deleteWarnDays: Number(platform.deleteWarnDays ?? DEFAULTS.deleteWarnDays),
  graceDays: Number(platform.graceDays || 0),
});

// When the restaurant's app closed, if it is closed for lack of payment.
function closedAt(row, graceDays, now = Date.now()) {
  if (row.get('suspended') === true || row.get('deleted') === true) return null;
  const access = accessOf(row, graceDays, now);
  if (access.ok) return null;
  // Signed up to pay and never did: closed since sign-up.
  if (access.payFirst || !access.until) return row.createdAt || null;
  return new Date(access.until.getTime() + graceDays * DAY);
}

// { closedAt, warnAt, deleteAt, warned } for a restaurant on its way to
// deletion; null when it is not (paying, in its trial, suspended by the
// platform, kept by the platform, or deletion is switched off).
function deletionOf(row, platform, now = Date.now()) {
  const s = settingsOf(platform);
  if (!(s.deleteAfterDays > 0) || row.get('neverDelete') === true) return null;
  const closed = closedAt(row, s.graceDays, now);
  if (!closed) return null;
  const planned = closed.getTime() + s.deleteAfterDays * DAY;
  // A warning from an earlier time it closed does not count.
  const warnedAt = row.get('deletionWarnedAt');
  const warned = warnedAt && warnedAt.getTime() >= closed.getTime() ? warnedAt : null;
  const notice = s.deleteWarnDays * DAY;
  const deleteAt = warned ? Math.max(planned, warned.getTime() + notice) : planned;
  return {
    closedAt: closed,
    warnAt: new Date(planned - notice),
    deleteAt: new Date(deleteAt),
    warned,
  };
}

// What to do now: 'warn', 'delete' or null.
function deletionStep(row, platform, now = Date.now()) {
  const state = deletionOf(row, platform, now);
  if (!state) return null;
  if (!state.warned) return now >= state.warnAt.getTime() ? 'warn' : null;
  return now >= state.deleteAt.getTime() ? 'delete' : null;
}

module.exports = { DEFAULTS, deletionOf, deletionStep, closedAt };
