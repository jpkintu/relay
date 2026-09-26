import { describe, expect, test } from 'vitest';
import { dayKey, formatMoney, greeting, initials, isToday, timeAgo } from './format';

describe('formatMoney', () => {
  test('uses the configured symbol and whole units', () => {
    expect(formatMoney(43000, 'UGX')).toBe('UGX 43,000');
    expect(formatMoney(1234.6, 'KSh')).toBe('KSh 1,235');
  });

  test('treats missing amounts as zero', () => {
    expect(formatMoney(undefined, 'UGX')).toBe('UGX 0');
  });
});

describe('timezone helpers', () => {
  const lateEveningUtc = new Date('2026-09-25T22:30:00Z');

  test('dayKey follows the restaurant timezone', () => {
    expect(dayKey(lateEveningUtc, 'UTC')).toBe('2026-09-25');
    expect(dayKey(lateEveningUtc, 'Africa/Kampala')).toBe('2026-09-26');
  });

  test('isToday compares calendar days in the timezone', () => {
    const now = new Date('2026-09-26T06:00:00Z');
    expect(isToday(lateEveningUtc, 'Africa/Kampala', now)).toBe(true);
    expect(isToday(lateEveningUtc, 'UTC', now)).toBe(false);
    expect(isToday(null, 'UTC', now)).toBe(false);
  });

  test('greeting uses the local hour', () => {
    expect(greeting('Africa/Kampala', new Date('2026-09-25T05:00:00Z'))).toBe('Good morning');
    expect(greeting('Africa/Kampala', new Date('2026-09-25T12:00:00Z'))).toBe('Good afternoon');
    expect(greeting('Africa/Kampala', new Date('2026-09-25T16:00:00Z'))).toBe('Good evening');
  });
});

test('initials', () => {
  expect(initials('Rita Nansubuga Rider')).toBe('RR');
  expect(initials('amina')).toBe('AM');
  expect(initials('  ')).toBe('?');
});

test('timeAgo', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  expect(timeAgo('2026-09-26T11:59:40Z', now)).toBe('just now');
  expect(timeAgo('2026-09-26T11:55:00Z', now)).toBe('5 min ago');
  expect(timeAgo('2026-09-26T09:00:00Z', now)).toBe('3 h ago');
  expect(timeAgo('2026-09-24T12:00:00Z', now)).toBe('2 d ago');
});
