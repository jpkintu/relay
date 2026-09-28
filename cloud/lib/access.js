// Relay Hosted (docs/HOSTED.md).

// A restaurant's access, worked out from its dates every time it is asked
// for, never a stored status a job has to keep up to date (lesson from the
// Embiro BI platform: a stale flag keeps or cuts access at the wrong time).
// `suspended` is a separate switch for the platform staff, independent of
// billing. Statuses: trial, active (paid), past_due (in the grace days after
// the paid or trial period ends: still usable), expired, suspended.
function accessOf(row, graceDays = 0, now = Date.now()) {
  if (row.get('suspended') === true) return { status: 'suspended', ok: false, until: null };
  const trial = row.get('trialEndsAt');
  const paid = row.get('paidUntil');
  const end = Math.max(trial ? trial.getTime() : 0, paid ? paid.getTime() : 0);
  if (end > now)
    return {
      status: paid && paid.getTime() === end ? 'active' : 'trial',
      ok: true,
      until: new Date(end),
    };
  const graceEnd = end + Number(graceDays || 0) * 86400000;
  if (end && graceEnd > now) return { status: 'past_due', ok: true, until: new Date(graceEnd) };
  return { status: 'expired', ok: false, until: end ? new Date(end) : null };
}

module.exports = { accessOf };
