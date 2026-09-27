import { describe, expect, test } from 'vitest';
import { checkImportRows, parsePrice } from './menuImport.js';

describe('parsePrice', () => {
  test('reads prices the way people type them', () => {
    expect(parsePrice('12,000')).toBe(12000);
    expect(parsePrice('UGX 12000')).toBe(12000);
    expect(parsePrice('1,250,000')).toBe(1250000);
    expect(parsePrice('7.50')).toBe(7.5);
    expect(parsePrice(3000)).toBe(3000);
  });
  test('rejects what is not a price', () => {
    expect(parsePrice('')).toBeNaN();
    expect(parsePrice('free')).toBeNaN();
    expect(parsePrice('1.2.3')).toBeNaN();
  });
});

describe('checkImportRows', () => {
  test('cleans valid rows and defaults the category', () => {
    const { rows, errors } = checkImportRows([
      { title: '  Chicken  stew ', price: '15,000', category: 'Mains', prepMinutes: '20' },
      { title: 'Soda', price: 2000 },
    ]);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        row: 2,
        title: 'Chicken stew',
        price: 15000,
        category: 'Mains',
        description: '',
        prepMinutes: 20,
      },
      {
        row: 3,
        title: 'Soda',
        price: 2000,
        category: 'Mains',
        description: '',
        prepMinutes: undefined,
      },
    ]);
  });
  test('reports each bad row by its spreadsheet row number', () => {
    const { rows, errors } = checkImportRows([
      { title: 'Soda', price: 2000 },
      { title: '', price: 100 },
      { title: 'Tea', price: 'abc' },
      { title: 'soda', price: 2500 },
      { title: 'Stew', price: 1, prepMinutes: '2.5' },
    ]);
    expect(rows.map((row) => row.title)).toEqual(['Soda']);
    expect(errors.map((error) => error.row)).toEqual([3, 4, 5, 6]);
    expect(errors[2].message).toMatch(/already on row 2/);
  });
  test('refuses an empty or oversized file', () => {
    expect(checkImportRows([]).errors[0].message).toMatch(/no dishes/);
    expect(checkImportRows(Array(501).fill({ title: 'x', price: 1 })).errors[0].message).toMatch(
      /at most 500/,
    );
  });
});
