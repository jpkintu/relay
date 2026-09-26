// Date ranges for filters and reports. Days are 'YYYY-MM-DD' strings in the
// restaurant timezone; the server turns them into UTC instants.

import { dayKey } from './format';

export type Period = 'day' | 'week' | 'month';
export type DateRange = { from: string; to: string };

export const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['thisWeek', 'This week'],
  ['lastWeek', 'Last week'],
  ['thisMonth', 'This month'],
  ['lastMonth', 'Last month'],
  ['last30', 'Last 30 days'],
  ['last8weeks', 'Last 8 weeks'],
  ['last90', 'Last 90 days'],
  ['last6months', 'Last 6 months'],
  ['last12months', 'Last 12 months'],
  ['thisYear', 'This year'],
] as const;
export type Preset = (typeof PRESETS)[number][0] | 'custom';

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(day: string, count: number): string {
  const date = utc(day);
  date.setUTCDate(date.getUTCDate() + count);
  return iso(date);
}

// First day of the month `count` months after the month of `day`.
export function addMonths(day: string, count: number): string {
  const date = utc(`${day.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return iso(date);
}

export const monday = (day: string) => addDays(day, -((utc(day).getUTCDay() + 6) % 7));

export function presetRange(preset: Exclude<Preset, 'custom'>, today: string): DateRange {
  const month = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'thisWeek':
      return { from: monday(today), to: today };
    case 'lastWeek':
      return { from: addDays(monday(today), -7), to: addDays(monday(today), -1) };
    case 'thisMonth':
      return { from: month, to: today };
    case 'lastMonth':
      return { from: addMonths(today, -1), to: addDays(month, -1) };
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'last8weeks':
      return { from: addDays(monday(today), -49), to: today };
    case 'last90':
      return { from: addDays(today, -89), to: today };
    case 'last6months':
      return { from: addMonths(today, -5), to: today };
    case 'last12months':
      return { from: addMonths(today, -11), to: today };
    case 'thisYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export const todayIn = (timeZone: string, now = new Date()) => dayKey(now, timeZone);

// Fixed month names: Intl output differs between browsers ("Sep" / "Sept").
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const month = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1];
const short = (day: string) => `${Number(day.slice(8, 10))} ${month(day)}`;
const full = (day: string) => `${short(day)} ${day.slice(0, 4)}`;

// Axis/table label for a bucket key from the server.
// `compact` gives shorter labels for phone-width chart axes.
export function bucketLabel(key: string, period: Period, compact = false): string {
  if (period === 'month')
    return `${month(`${key}-01`)} ${compact ? `’${key.slice(2, 4)}` : key.slice(0, 4)}`;
  if (period === 'week') return compact ? short(key) : `Wk of ${short(key)}`;
  return short(key);
}

export function rangeLabel({ from, to }: DateRange): string {
  if (from === to) return full(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${(sameYear ? short : full)(from)} – ${full(to)}`;
}

// Signed percentage for deltas, e.g. "+12.5%"; '' when there is nothing to compare.
export function formatChange(change: number | null | undefined): string {
  if (change === null || change === undefined) return '';
  return `${change > 0 ? '+' : ''}${change}%`;
}

// Short money for chart labels: 1.75M, 906k, 950.
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const trim = (n: number) => String(Math.round(n * 100) / 100);
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}k`;
  return String(Math.round(value));
}

export function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}
