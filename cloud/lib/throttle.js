// "At most every N ms" for work done on the back of normal app use (the
// Z-report, stale handover alerts, payment request sweeps, the daily upkeep),
// so it happens without scheduled jobs but not on every request. Kept per
// server; the work itself must be safe to repeat.

const last = new Map();

// Relay Hosted: each restaurant has its own timers, so one restaurant's
// activity never uses up another's turn.
const scope = () => require('./tenant').current() || '';

// True (and starts a new wait) when `name` last ran more than `ms` ago; a
// negative `ms` switches the work off.
function due(name, ms) {
  if (!(ms >= 0)) return false;
  const key = `${name}:${scope()}`;
  const now = Date.now();
  if (now - (last.get(key) || 0) < ms) return false;
  last.set(key, now);
  if (last.size > 10000) last.clear();
  return true;
}

module.exports = { due };
