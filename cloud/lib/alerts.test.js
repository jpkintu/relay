import { expect, test } from 'vitest';
import { floatLevel, handoverReminderDue } from './alerts.js';

test('floatLevel', () => {
  expect(floatLevel(0, 200000)).toBeNull();
  expect(floatLevel(159999, 200000)).toBeNull();
  expect(floatLevel(160000, 200000)).toBe('near');
  expect(floatLevel(200000, 200000)).toBe('reached');
  expect(floatLevel(250000, 200000)).toBe('reached');
  expect(floatLevel(90000, 100000, 90)).toBe('near');
  expect(floatLevel(89999, 100000, 90)).toBeNull();
  expect(floatLevel(500000, 0)).toBeNull();
});

test('handoverReminderDue', () => {
  expect(handoverReminderDue(5000, 20, 20)).toBe(true);
  expect(handoverReminderDue(5000, 19, 20)).toBe(false);
  expect(handoverReminderDue(0, 22, 20)).toBe(false);
  expect(handoverReminderDue(5000, 23, 25)).toBe(false);
});
