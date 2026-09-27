import { describe, expect, test } from 'vitest';
import { MENU_TEMPLATE, menuRowsFromCsv, parseCsv } from './csv';

describe('parseCsv', () => {
  test('quoted cells, escaped quotes, line breaks and Windows endings', () => {
    const text =
      String.fromCharCode(0xfeff) +
      'Name,Price,Description\r\n"Stew, beef",12000,"Say ""hi""\nnow"\r\nTea,2000,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Price', 'Description'],
      ['Stew, beef', '12000', 'Say "hi"\nnow'],
      ['Tea', '2000', ''],
    ]);
  });
  test('semicolon and tab separated files', () => {
    expect(parseCsv('Name;Price\nTea;"2,000"')).toEqual([
      ['Name', 'Price'],
      ['Tea', '2,000'],
    ]);
    expect(parseCsv('Name\tPrice\nTea\t2000')).toEqual([
      ['Name', 'Price'],
      ['Tea', '2000'],
    ]);
  });
});

describe('menuRowsFromCsv', () => {
  test('matches the usual column names in any order', () => {
    const { rows, problem } = menuRowsFromCsv(
      parseCsv('Section,Dish Name,Price (UGX),Prep time\nDrinks,Tea,"2,000",5'),
    );
    expect(problem).toBe('');
    expect(rows).toEqual([
      { title: 'Tea', price: '2,000', category: 'Drinks', description: '', prepMinutes: '5' },
    ]);
  });
  test('the template reads back', () => {
    expect(menuRowsFromCsv(parseCsv(MENU_TEMPLATE)).rows).toHaveLength(3);
  });
  test('says which required column is missing', () => {
    expect(menuRowsFromCsv(parseCsv('Dish,Category\nTea,Drinks')).problem).toMatch(/"Price"/);
    expect(menuRowsFromCsv(parseCsv('Name,Price')).problem).toMatch(/at least one dish/);
  });
});
