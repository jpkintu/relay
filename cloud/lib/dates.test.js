import { expect, test } from 'vitest';
import {
  addDays,
  bucketKeys,
  bucketOfDay,
  dateKey,
  isoDay,
  isValidTimeZone,
  localClock,
  previousRange,
  resolveRange,
  startOfDay,
} from './dates.js';

test('dateKey uses the restaurant timezone, not UTC', () => {
  const lateEveningUtc = new Date('2026-09-25T22:30:00Z');
  expect(dateKey(lateEveningUtc, 'UTC')).toBe('20260925');
  expect(dateKey(lateEveningUtc, 'Africa/Kampala')).toBe('20260926');
});

test('isValidTimeZone', () => {
  expect(isValidTimeZone('Africa/Kampala')).toBe(true);
  expect(isValidTimeZone('Mars/Olympus')).toBe(false);
});

test('startOfDay returns the UTC instant local midnight begins', () => {
  expect(startOfDay('2026-09-26', 'Africa/Kampala').toISOString()).toBe('2026-09-25T21:00:00.000Z');
  expect(startOfDay('2026-09-26', 'UTC').toISOString()).toBe('2026-09-26T00:00:00.000Z');
  // Across a daylight-saving change (New York springs forward on 8 March 2026).
  expect(startOfDay('2026-03-08', 'America/New_York').toISOString()).toBe(
    '2026-03-08T05:00:00.000Z',
  );
  expect(startOfDay('2026-03-09', 'America/New_York').toISOString()).toBe(
    '2026-03-09T04:00:00.000Z',
  );
});

test('isoDay and localClock use the restaurant timezone', () => {
  const instant = new Date('2026-09-27T22:30:00Z'); // Monday 01:30 in Kampala
  expect(isoDay(instant, 'Africa/Kampala')).toBe('2026-09-28');
  expect(localClock(instant, 'Africa/Kampala')).toEqual({ hour: 1, weekday: 0 });
});

test('bucket keys cover every day, week or month in the range', () => {
  expect(bucketOfDay('2026-09-26', 'week')).toBe('2026-09-21');
  expect(bucketOfDay('2026-09-21', 'week')).toBe('2026-09-21');
  expect(bucketOfDay('2026-09-26', 'month')).toBe('2026-09');
  expect(bucketKeys('2026-09-19', '2026-10-02', 'week')).toEqual([
    '2026-09-14',
    '2026-09-21',
    '2026-09-28',
  ]);
  expect(bucketKeys('2026-07-31', '2026-09-01', 'month')).toEqual([
    '2026-07',
    '2026-08',
    '2026-09',
  ]);
  expect(bucketKeys('2026-09-01', '2026-09-03', 'day')).toHaveLength(3);
});

test('resolveRange validates and defaults', () => {
  const range = resolveRange({ from: '2026-09-01', to: '2026-09-30' }, 'Africa/Kampala');
  expect(range.days).toBe(30);
  expect(range.start.toISOString()).toBe('2026-08-31T21:00:00.000Z');
  expect(range.end.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  expect(resolveRange({ from: '2026-09-31', to: '2026-10-01' }, 'UTC').error).toBeTruthy();
  expect(resolveRange({ from: '2026-10-02', to: '2026-10-01' }, 'UTC').error).toMatch(/after/);
  expect(resolveRange({ from: '2024-01-01', to: '2026-01-01' }, 'UTC').error).toMatch(/366/);
  expect(resolveRange({}, 'UTC', { defaultDays: 7 }).days).toBe(7);
  expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
});

test('previousRange is the same length just before', () => {
  const range = resolveRange({ from: '2026-09-01', to: '2026-09-30' }, 'UTC');
  const before = previousRange(range, 'UTC');
  expect([before.from, before.to]).toEqual(['2026-08-02', '2026-08-31']);
});
