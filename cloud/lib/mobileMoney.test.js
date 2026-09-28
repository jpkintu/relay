import { expect, test } from 'vitest';
import { cleanReference, merchantAccounts, referenceProblem } from './mobileMoney.js';

test('merchantAccounts lists only providers with a merchant code', () => {
  expect(
    merchantAccounts({
      mtnMerchantCode: ' 123456 ',
      mtnMerchantName: 'Relay Foods',
      airtelMerchantCode: '',
    }),
  ).toEqual([
    { provider: 'mtn', label: 'MTN MoMo', code: '123456', name: 'Relay Foods', auto: false },
  ]);
  expect(merchantAccounts({})).toEqual([]);
});

test('automatic payments list a provider even without a merchant code', () => {
  expect(merchantAccounts({ airtelAutoCollect: true })).toEqual([
    { provider: 'airtel', label: 'Airtel Money', code: '', name: '', auto: true },
  ]);
});

test('transaction IDs are normalised and validated', () => {
  expect(cleanReference(' mp240925.1234 abc ')).toBe('MP240925.1234ABC');
  expect(referenceProblem('')).toMatch(/Enter the transaction ID/);
  expect(referenceProblem('AB')).toMatch(/4 to 40/);
  expect(referenceProblem('AB#12')).toMatch(/4 to 40/);
  expect(referenceProblem('8123456789')).toBe('');
});
