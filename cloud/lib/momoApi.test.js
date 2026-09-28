import { describe, expect, test } from 'vitest';
import { payerNumber } from './momoApi.js';

describe('payerNumber', () => {
  test('MTN takes the international number, Airtel the national one', () => {
    for (const typed of ['0772 123456', '+256772123456', '256772123456', '00256 772 123 456'])
      expect(payerNumber('mtn', typed)).toBe('256772123456');
    expect(payerNumber('airtel', '0752123456')).toBe('752123456');
    expect(payerNumber('airtel', '+256 752 123 456')).toBe('752123456');
  });
  test('refuses numbers that are too short or long', () => {
    expect(payerNumber('mtn', '0772')).toBe('');
    expect(payerNumber('mtn', '')).toBe('');
    expect(payerNumber('airtel', '07521234567890')).toBe('');
  });
  test('MTN test environment numbers pass through unchanged', () => {
    expect(payerNumber('mtn', '46733123451')).toBe('46733123451');
    expect(payerNumber('mtn', '+46 733 123 452')).toBe('46733123452');
    expect(payerNumber('airtel', '46733123451')).toBe('');
  });
  test('uses another country code when set', () => {
    expect(payerNumber('mtn', '0712345678', '254')).toBe('254712345678');
  });
});
