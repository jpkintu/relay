import { describe, expect, test } from 'vitest';
import { availableGroups, normalizeGroups, selectionError } from './accompaniments.js';

const known = new Set(['matooke', 'pumpkin', 'yams', 'vegrice', 'friedrice']);
const stew = [
  { label: 'Rice', options: ['vegrice', 'friedrice'], min: 0, max: 1 },
  { label: 'Sides', options: ['matooke', 'pumpkin', 'yams'], min: 0, max: 3 },
];

describe('normalizeGroups', () => {
  test('accepts valid groups and defaults max to all options', () => {
    expect(normalizeGroups([{ label: ' Sides ', options: ['matooke', 'yams'] }], known)).toEqual([
      { label: 'Sides', options: ['matooke', 'yams'], min: 0, max: 2 },
    ]);
  });

  test('treats missing groups as none', () => {
    expect(normalizeGroups(undefined, known)).toEqual([]);
  });

  test('rejects unknown accompaniments and impossible limits', () => {
    expect(() => normalizeGroups([{ label: 'X', options: ['chips'] }], known)).toThrow(
      /does not exist/,
    );
    expect(() => normalizeGroups([{ label: 'X', options: ['yams'], max: 2 }], known)).toThrow(
      /between 1 and 1/,
    );
    expect(() =>
      normalizeGroups([{ label: 'X', options: ['yams'], min: 2, max: 1 }], known),
    ).toThrow(/at least/);
    expect(() => normalizeGroups([{ label: 'X', options: [] }], known)).toThrow(/at least one/);
  });
});

describe('availableGroups', () => {
  test('hides sold-out accompaniments and relaxes limits', () => {
    const groups = availableGroups(
      [{ label: 'Rice', options: ['vegrice', 'friedrice'], min: 1, max: 1 }, stew[1]],
      (id) => !['vegrice', 'friedrice', 'yams'].includes(id),
    );
    expect(groups).toEqual([{ label: 'Sides', options: ['matooke', 'pumpkin'], min: 0, max: 2 }]);
  });
});

describe('selectionError', () => {
  test('allows any valid combination, including none', () => {
    expect(selectionError(stew, [])).toBe('');
    expect(selectionError(stew, ['friedrice', 'matooke', 'pumpkin'])).toBe('');
  });

  test('vegetable rice and fried rice cannot both be chosen', () => {
    expect(selectionError(stew, ['vegrice', 'friedrice'])).toBe('Choose only one rice option');
  });

  test('rejects accompaniments the dish does not offer, duplicates and missing required choices', () => {
    expect(selectionError(stew, ['chips'])).toMatch(/not available/);
    expect(selectionError(stew, ['yams', 'yams'])).toMatch(/twice/);
    expect(selectionError([{ ...stew[1], min: 1 }], [])).toBe('Choose at least 1 from Sides');
  });
});
