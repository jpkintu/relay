import { expect, test } from 'vitest';
import { strongestTone } from './sound';

test('strongestTone picks the most urgent sound', () => {
  expect(strongestTone([])).toBeNull();
  expect(strongestTone(['update', 'update'])).toBe('update');
  expect(strongestTone(['update', 'new'])).toBe('new');
  expect(strongestTone(['new', 'alert', 'update'])).toBe('alert');
});
