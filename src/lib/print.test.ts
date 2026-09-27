import { describe, expect, test } from 'vitest';
import { receiptHtml } from './print';

const receipt = {
  restaurant: 'Mama <Rose>',
  header: 'Plot 12\nTel 0772',
  footer: 'Thanks!',
  width: 80,
  code: 'ORD-20260927-0012',
  type: 'eat_in',
  status: 'PLACED',
  table: 'Table 4',
  channel: 'walkin',
  placedAt: '2026-09-27T09:30:00Z',
  customer: 'Eat-in guest',
  phone: '',
  address: '',
  notes: 'Table 4',
  rider: '',
  staff: 'C-001 · Carol',
  lines: [
    {
      name: 'Chicken & chips',
      qty: 2,
      price: 9000,
      total: 18000,
      notes: 'No salt',
      accompaniments: ['Rice'],
    },
  ],
  subtotal: 18000,
  deliveryFee: 0,
  total: 18000,
  payment: { method: 'cash', provider: '', reference: '', state: 'paid' as const, paidAt: null },
};

describe('printed receipts', () => {
  test('the kitchen ticket has the items and notes but no prices', () => {
    const html = receiptHtml.kitchenTicket(receipt, 'Africa/Kampala');
    expect(html).toContain('0012');
    expect(html).toContain('EAT IN · Table 4');
    expect(html).toContain('Chicken &amp; chips');
    expect(html).toContain('No salt');
    expect(html).toContain('Rice');
    expect(html).not.toContain('18,000');
  });
  test('the customer receipt has prices, payment and escaped text', () => {
    const html = receiptHtml.customerReceipt(receipt, 'Africa/Kampala', 'UGX');
    expect(html).toContain('Mama &lt;Rose&gt;');
    expect(html).toContain('Plot 12<br>Tel 0772');
    expect(html).toContain('UGX 18,000');
    expect(html).toContain('PAID · Cash');
    expect(html).toContain('Served by C-001 · Carol');
    const unpaid = receiptHtml.customerReceipt(
      { ...receipt, payment: { ...receipt.payment, state: 'unpaid' } },
      'Africa/Kampala',
      'UGX',
    );
    expect(unpaid).toContain('NOT PAID');
  });
});
