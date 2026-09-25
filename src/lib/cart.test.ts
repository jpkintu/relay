import { describe, expect, test } from 'vitest';
import {
  addToCart,
  cartCount,
  cartSubtotal,
  changeQuantity,
  describeLine,
  previewCommission,
  selectionProblem,
  toggleOption,
} from './cart';

const stew = { id: 'stew', title: 'Chicken stew', price: 25000 };
const matooke = { id: 'm', title: 'Matooke' };
const friedRice = { id: 'f', title: 'Fried rice' };
const vegRice = { id: 'v', title: 'Vegetable rice' };
const rice = { label: 'Rice', min: 0, max: 1, options: [vegRice, friedRice] };
const sides = {
  label: 'Sides',
  min: 0,
  max: 2,
  options: [matooke, { id: 'p', title: 'Pumpkin' }, { id: 'y', title: 'Yams' }],
};

describe('cart lines', () => {
  test('same dish with the same accompaniments merges; different ones stay separate', () => {
    let cart = addToCart([], stew, 1, [matooke, friedRice]);
    cart = addToCart(cart, stew, 1, [friedRice, matooke]);
    cart = addToCart(cart, stew, 1, [vegRice]);
    expect(cart).toHaveLength(2);
    expect(cart[0].quantity).toBe(2);
    expect(cartCount(cart)).toBe(3);
    expect(cartSubtotal(cart)).toBe(75000);
  });

  test('quantity changes remove a line at zero', () => {
    const cart = addToCart([], stew, 1);
    expect(changeQuantity(cart, cart[0].key, -1)).toEqual([]);
  });

  test('describeLine lists accompaniments then notes', () => {
    expect(describeLine({ accompaniments: [matooke, friedRice], notes: 'No onions' })).toBe(
      'Matooke, Fried rice · No onions',
    );
  });
});

describe('accompaniment picking', () => {
  test('a single-choice group swaps instead of allowing both rices', () => {
    let selected = toggleOption(rice, [], 'v');
    selected = toggleOption(rice, selected, 'f');
    expect(selected).toEqual(['f']);
  });

  test('a multi-choice group stops at its maximum', () => {
    let selected = toggleOption(sides, [], 'm');
    selected = toggleOption(sides, selected, 'p');
    selected = toggleOption(sides, selected, 'y');
    expect(selected).toEqual(['m', 'p']);
  });

  test('selectionProblem enforces minimums', () => {
    expect(selectionProblem([{ ...sides, min: 1 }], [])).toBe('Choose at least 1 from Sides');
    expect(selectionProblem([rice, sides], ['f', 'm'])).toBe('');
  });
});

test('previewCommission matches the server formula', () => {
  expect(previewCommission({ type: 'hybrid', perOrder: 1000, percent: 10 }, 37000)).toBe(4700);
  expect(previewCommission({ type: 'percent', perOrder: 0, percent: 7 }, 12345, 'up_100')).toBe(
    900,
  );
  expect(previewCommission(null, 1000)).toBe(0);
});
