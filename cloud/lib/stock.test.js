import { expect, test } from 'vitest';
import {
  isLow,
  latestByBranch,
  onHand,
  onHandByBranch,
  priceCount,
  reorderLevelFor,
  stockValueAt,
} from './stock.js';

const day = (d) => new Date(`2026-09-${String(d).padStart(2, '0')}T20:00:00Z`);
// Two branches, counted on different days.
const counts = [
  { branch: 'A', at: day(1), total: 50000, lines: [{ itemId: 'rice', quantity: 10 }] },
  { branch: 'A', at: day(10), total: 30000, lines: [{ itemId: 'rice', quantity: 6 }] },
  {
    branch: 'B',
    at: day(5),
    total: 20000,
    lines: [
      { itemId: 'rice', quantity: 4 },
      { itemId: 'oil', quantity: 2 },
    ],
  },
];

test('stock value: each branch’s latest count before the moment, added up', () => {
  expect(stockValueAt(counts, day(1))).toBe(0);
  expect(stockValueAt(counts, day(2))).toBe(50000);
  expect(stockValueAt(counts, day(6))).toBe(70000);
  expect(stockValueAt(counts, day(11))).toBe(50000);
  expect(latestByBranch(counts).get('A').total).toBe(30000);
});

test('on hand: the latest count plus linked purchases since, per branch', () => {
  const purchases = [
    // Before branch A's latest count: already in it.
    { branch: 'A', at: day(9), lines: [{ itemId: 'rice', quantity: 5 }] },
    { branch: 'A', at: day(12), lines: [{ itemId: 'rice', quantity: 2.5 }, { quantity: 1 }] },
    { branch: 'B', at: day(6), lines: [{ itemId: 'oil', quantity: 1 }] },
    // Never counted: what was bought.
    { branch: 'B', at: day(7), lines: [{ itemId: 'salt', quantity: 3 }] },
  ];
  const map = onHand(counts, purchases);
  expect(map.get('rice')).toEqual({ quantity: 6 + 2.5 + 4, counted: true });
  expect(map.get('oil')).toEqual({ quantity: 3, counted: true });
  expect(map.get('salt')).toEqual({ quantity: 3, counted: false });
  // A restored item: its old id maps to the new one.
  const restored = onHand(counts, [], (id) => (id === 'rice' ? 'rice2' : id));
  expect(restored.get('rice2').quantity).toBe(10);
});

test('pricing a count, and low stock', () => {
  const { lines, total } = priceCount([
    { itemId: 'rice', quantity: 2.5, unitCost: 4000 },
    { itemId: 'oil', quantity: 1, unitCost: 9000 },
  ]);
  expect(lines[0].value).toBe(10000);
  expect(total).toBe(19000);
  expect(isLow({ reorderLevel: 5 }, 5)).toBe(true);
  expect(isLow({ reorderLevel: 5 }, 5.5)).toBe(false);
  expect(isLow({ reorderLevel: 0 }, 0)).toBe(false);
});

test('stock is kept by branch: each its own quantities and reorder levels', () => {
  const purchases = [{ branch: 'B', at: day(6), lines: [{ itemId: 'oil', quantity: 1 }] }];
  const map = onHandByBranch(counts, purchases);
  expect(map.get('rice').get('A')).toEqual({ quantity: 6, counted: true });
  expect(map.get('rice').get('B')).toEqual({ quantity: 4, counted: true });
  expect(map.get('oil').get('B').quantity).toBe(3);
  expect(map.get('oil').has('A')).toBe(false);
  const rice = { reorderLevel: 5, reorderLevels: { B: 2 } };
  expect(reorderLevelFor(rice, 'A')).toBe(5);
  expect(reorderLevelFor(rice, 'B')).toBe(2);
  // 4 kg is low for branch A's level, not for B's.
  expect(isLow(rice, 4, 'A')).toBe(true);
  expect(isLow(rice, 4, 'B')).toBe(false);
});
