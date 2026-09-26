// Date helpers that respect the restaurant timezone. Store UTC, display local.
//
// Calendar days travel between client and server as 'YYYY-MM-DD' strings in
// the restaurant timezone; startOfDay turns one into the UTC instant it begins.

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
function partsOf(date, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const out = {};
  for (const part of format.formatToParts(date)) out[part.type] = part.value;
  return out;
}

// 'YYYYMMDD' for the calendar day of `date` in `timeZone`.
function dateKey(date, timeZone) {
  const p = partsOf(date, timeZone);
  return `${p.year}${p.month}${p.day}`;
}

// 'YYYY-MM-DD' for the calendar day of `date` in `timeZone`.
function isoDay(date, timeZone) {
  const p = partsOf(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Local hour (0-23) and weekday (0 = Monday … 6 = Sunday).
function localClock(date, timeZone) {
  const p = partsOf(date, timeZone);
  const day = isoDay(date, timeZone);
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { hour: Number(p.hour) % 24, weekday };
}

function offsetMs(instant, timeZone) {
  const p = partsOf(new Date(instant), timeZone);
  const local = Date.UTC(p.year, p.month - 1, p.day, Number(p.hour) % 24, p.minute, p.second);
  return local - Math.floor(instant / 1000) * 1000;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
function isDay(value) {
  const match = DAY_PATTERN.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.toISOString().slice(0, 10) === value;
}

// The UTC instant when calendar day `day` ('YYYY-MM-DD') starts in `timeZone`.
function startOfDay(day, timeZone) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let instant = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// Bucket key for a calendar day: the day itself, the Monday that starts its
// week, or 'YYYY-MM'.
function bucketOfDay(day, period) {
  if (period === 'month') return day.slice(0, 7);
  if (period === 'week') {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(day, -weekday);
  }
  return day;
}

const bucketOf = (date, timeZone, period) => bucketOfDay(isoDay(date, timeZone), period);

// Every bucket key from `from` to `to` (inclusive), so empty periods show as 0.
function bucketKeys(from, to, period) {
  const keys = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const key = bucketOfDay(day, period);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

// Validates a { from, to } pair of 'YYYY-MM-DD' days (inclusive) and returns
// the UTC interval [start, end). Missing values default to the last
// `defaultDays` days ending today.
function resolveRange(params, timeZone, { defaultDays = 30, maxDays = 366 } = {}) {
  const today = isoDay(new Date(), timeZone);
  const to = params?.to || today;
  const from = params?.from || addDays(to, -(defaultDays - 1));
  if (!isDay(from) || !isDay(to)) return { error: 'Dates must look like 2026-09-01' };
  if (from > to) return { error: 'The start date is after the end date' };
  const days = daysBetween(from, to) + 1;
  if (days > maxDays) return { error: `Choose at most ${maxDays} days` };
  return {
    from,
    to,
    days,
    start: startOfDay(from, timeZone),
    end: startOfDay(addDays(to, 1), timeZone),
  };
}

// The same number of days immediately before `range`.
function previousRange(range, timeZone) {
  const to = addDays(range.from, -1);
  const from = addDays(to, -(range.days - 1));
  return resolveRange({ from, to }, timeZone, { maxDays: range.days });
}

module.exports = {
  isValidTimeZone,
  dateKey,
  isoDay,
  localClock,
  isDay,
  startOfDay,
  addDays,
  daysBetween,
  bucketOf,
  bucketOfDay,
  bucketKeys,
  resolveRange,
  previousRange,
};
