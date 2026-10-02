import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The backup (cloud/data.js EXPORT_CLASSES), the server's restore order
// (cloud/restore.js ORDER) and the app's (src/components/AdminData.tsx
// RESTORE_ORDER) must cover the same classes, in the same order for the
// last two: a class missing from one is silently left out of a restore.
const list = (file, name) => {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const body = text.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1];
  return [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]);
};

test('backups and both restore orders cover the same classes', () => {
  const exported = list('../data.js', 'EXPORT_CLASSES');
  const server = list('../restore.js', 'ORDER');
  const app = list('../../src/components/AdminData.tsx', 'RESTORE_ORDER');
  expect(app).toEqual(server);
  expect([...server].sort()).toEqual([...exported].sort());
  for (const name of ['DiningTable', 'Voucher', 'StockItem', 'StockCount', 'Purchase'])
    expect(server).toContain(name);
  // What a record links to comes before it.
  const before = (a, b) => expect(server.indexOf(a)).toBeLessThan(server.indexOf(b));
  before('Branch', 'DiningTable');
  before('DiningTable', 'Order');
  before('Order', 'Voucher');
  before('StockItem', 'StockCount');
});
