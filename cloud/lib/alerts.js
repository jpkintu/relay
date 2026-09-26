// Pure rules for rider cash alerts, so they can be unit-tested.

// 'reached' when the cash with the rider is at or over the limit, 'near' when
// it is at or over `warnPercent` of it, otherwise null. No limit → null.
function floatLevel(float, max, warnPercent = 80) {
  const limit = Number(max) || 0;
  const cash = Number(float) || 0;
  if (limit <= 0) return null;
  if (cash >= limit) return 'reached';
  const percent = Math.min(Math.max(Number(warnPercent) || 80, 1), 99);
  if (cash >= (limit * percent) / 100) return 'near';
  return null;
}

// Whether the end-of-day handover reminder is due: the rider holds cash and
// the local hour is at or past the reminder hour (0-23).
function handoverReminderDue(float, localHour, reminderHour = 20) {
  const hour = Number(reminderHour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  return (Number(float) || 0) > 0 && localHour >= hour;
}

module.exports = { floatLevel, handoverReminderDue };
