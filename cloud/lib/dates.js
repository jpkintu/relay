// Date helpers that respect the restaurant timezone. Store UTC, display local.

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// 'YYYYMMDD' for the calendar day of `date` in `timeZone`.
function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

module.exports = { isValidTimeZone, dateKey };
