import { describe, expect, test } from 'vitest';
import {
  addMonths,
  bucketLabel,
  compactNumber,
  formatChange,
  monday,
  presetRange,
  rangeLabel,
  truncate,
} from './range';

describe('presetRange', () => {
  const today = '2026-09-26'; // a Saturday
  test('days and weeks', () => {
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('yesterday', today)).toEqual({ from: '2026-09-25', to: '2026-09-25' });
    expect(presetRange('last7', today)).toEqual({ from: '2026-09-20', to: today });
    expect(presetRange('thisWeek', today)).toEqual({ from: '2026-09-21', to: today });
    expect(presetRange('lastWeek', today)).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    expect(presetRange('last8weeks', today)).toEqual({ from: '2026-08-03', to: today });
  });
  test('months and years', () => {
    expect(presetRange('thisMonth', today)).toEqual({ from: '2026-09-01', to: today });
    expect(presetRange('lastMonth', today)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(presetRange('last6months', today)).toEqual({ from: '2026-04-01', to: today });
    expect(presetRange('last12months', today)).toEqual({ from: '2025-10-01', to: today });
    expect(presetRange('thisYear', today)).toEqual({ from: '2026-01-01', to: today });
    expect(presetRange('lastMonth', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

test('helpers', () => {
  expect(monday('2026-09-21')).toBe('2026-09-21');
  expect(monday('2026-09-27')).toBe('2026-09-21');
  expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
  expect(bucketLabel('2026-09', 'month')).toBe('Sep 2026');
  expect(bucketLabel('2026-09-21', 'week')).toBe('Wk of 21 Sep');
  expect(bucketLabel('2026-09-21', 'day')).toBe('21 Sep');
  expect(rangeLabel({ from: '2026-09-01', to: '2026-09-26' })).toBe('1 Sep – 26 Sep 2026');
  expect(rangeLabel({ from: '2026-09-26', to: '2026-09-26' })).toBe('26 Sep 2026');
  expect(formatChange(12.5)).toBe('+12.5%');
  expect(formatChange(-3)).toBe('-3%');
  expect(formatChange(null)).toBe('');
  expect(bucketLabel('2026-09', 'month', true)).toBe('Sep ’26');
  expect(bucketLabel('2026-09-21', 'week', true)).toBe('21 Sep');
  expect(compactNumber(1750000)).toBe('1.75M');
  expect(compactNumber(906500)).toBe('906.5k');
  expect(compactNumber(950)).toBe('950');
  expect(truncate('Chicken stew with groundnut sauce', 16)).toBe('Chicken stew wi…');
  expect(truncate('Chips', 16)).toBe('Chips');
});
