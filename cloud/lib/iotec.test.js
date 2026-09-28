import { describe, expect, test } from 'vitest';
import { outcome, payerMsisdn } from './iotec.js';

describe('ioTec helpers', () => {
  test('payer numbers in the national form ioTec takes', () => {
    expect(payerMsisdn('+256 772 123 456')).toBe('0772123456');
    expect(payerMsisdn('0772123456')).toBe('0772123456');
    expect(payerMsisdn('772123456')).toBe('0772123456');
  });
  test('statuses map to pending, paid or failed', () => {
    expect(outcome({ status: 'Pending', statusMessage: 'Request is being processed' })).toEqual({
      status: 'pending',
      message: 'Request is being processed',
      reference: '',
    });
    expect(outcome({ status: 'Success', vendorTransactionId: 'MP123' })).toMatchObject({
      status: 'paid',
      reference: 'MP123',
    });
    expect(outcome({ status: 'Failed', statusMessage: 'Declined' }).status).toBe('failed');
    expect(outcome({}).status).toBe('pending');
  });
});
