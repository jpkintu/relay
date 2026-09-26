// Formatting helpers. Currency and timezone always come from Configuration;
// a fixed locale keeps number formatting the same on every device.

const NUMBER_LOCALE = 'en-US';

export function formatMoney(amount: number | null | undefined, symbol: string): string {
  const value = Math.round(Number(amount) || 0).toLocaleString(NUMBER_LOCALE);
  return symbol ? `${symbol} ${value}` : value;
}

// 'YYYY-MM-DD' for the calendar day of `date` in `timeZone`.
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function isToday(
  date: Date | null | undefined,
  timeZone: string,
  now = new Date(),
): boolean {
  return !!date && dayKey(date, timeZone) === dayKey(now, timeZone);
}

export function hourIn(timeZone: string, now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
}

export function greeting(timeZone: string, now = new Date()): string {
  const hour = hourIn(timeZone, now);
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function formatDate(
  date: Date | string | null | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(new Date(date));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (
    parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)
  ).toUpperCase();
}

// "just now", "5 min ago", "3 h ago", "2 d ago".
export function timeAgo(date: Date | string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
