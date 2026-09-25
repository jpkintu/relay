import { expect, test } from 'vitest';
import { dateKey, isValidTimeZone } from './dates.js';

test('dateKey uses the restaurant timezone, not UTC', () => {
  const lateEveningUtc = new Date('2026-09-25T22:30:00Z');
  expect(dateKey(lateEveningUtc, 'UTC')).toBe('20260925');
  expect(dateKey(lateEveningUtc, 'Africa/Kampala')).toBe('20260926');
});

test('isValidTimeZone', () => {
  expect(isValidTimeZone('Africa/Kampala')).toBe(true);
  expect(isValidTimeZone('Mars/Olympus')).toBe(false);
});
