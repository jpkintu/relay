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
  test('each side has its own line and amount under its dish; the amounts add up', () => {
    const fish = {
      ...receipt,
      lines: [
        {
          name: 'Whole Fish',
          qty: 1,
          price: 27000,
          total: 29000,
          notes: '',
          accompaniments: ['Deep Fried', 'Fresh Vegetables', 'Chips'],
          accompanimentPrices: [0, 0, 2000],
        },
      ],
    };
    const html = receiptHtml.customerReceipt(fish, 'Africa/Kampala', 'UGX');
    expect(html).toContain('Whole Fish</td>');
    expect(html).toContain('UGX 27,000');
    expect(html.match(/<tr class="side">/g)).toHaveLength(3);
    expect(html).toMatch(/\+ Deep Fried<\/td>\s*<td class="num sub">UGX 0</);
    expect(html).toMatch(/\+ Chips<\/td>\s*<td class="num sub">UGX 2,000</);
    // Two portions: each side's amount is per portion × quantity.
    const two = receiptHtml.customerReceipt(
      { ...fish, lines: [{ ...fish.lines[0], qty: 2, total: 58000 }] },
      'Africa/Kampala',
      'UGX',
    );
    expect(two).toContain('UGX 54,000');
    expect(two).toMatch(/\+ Chips<\/td>\s*<td class="num sub">UGX 4,000</);
    const ticket = receiptHtml.kitchenTicket(fish, 'Africa/Kampala');
    expect(ticket.match(/<div class="sub">\+ /g)).toHaveLength(3);
    expect(ticket).not.toContain('2,000');
  });

  test('the receipt shows the restaurant logo only when there is one', () => {
    expect(receiptHtml.customerReceipt(receipt, 'Africa/Kampala', 'UGX')).not.toContain('<img');
    const html = receiptHtml.customerReceipt(
      { ...receipt, logo: 'https://files.example/logo.png?a=1&b=2' },
      'Africa/Kampala',
      'UGX',
    );
    expect(html).toContain('<img class="logo" src="https://files.example/logo.png?a=1&amp;b=2"');
    expect(
      receiptHtml.kitchenTicket({ ...receipt, logo: 'x.png' }, 'Africa/Kampala'),
    ).not.toContain('<img');
  });

  test('the EFRIS part: FDN, verification code and QR once issued, a note while pending', () => {
    const efris = {
      status: 'issued' as const,
      fdn: '322000150744',
      verification: '31359767222004350398',
      qr: 'https://efris.example/verify',
      tin: '1000029771',
      legalName: 'Mama Rose Kitchen Ltd',
      kind: 'invoice' as const,
      test: false,
    };
    const html = receiptHtml.customerReceipt(
      { ...receipt, efris },
      'Africa/Kampala',
      'UGX',
      'data:image/png;base64,AAA',
    );
    expect(html).toContain('EFRIS TAX INVOICE');
    expect(html).toContain('FDN: <b>322000150744</b>');
    expect(html).toContain('Verification code: 31359767222004350398');
    expect(html).toContain('TIN: 1000029771');
    expect(html).toContain('<img class="qr" src="data:image/png;base64,AAA"');
    const pending = receiptHtml.customerReceipt(
      { ...receipt, efris: { ...efris, status: 'failed', fdn: '' } },
      'Africa/Kampala',
      'UGX',
    );
    expect(pending).toContain('EFRIS invoice pending');
    expect(receiptHtml.customerReceipt(receipt, 'Africa/Kampala', 'UGX')).not.toContain('EFRIS');
    expect(receiptHtml.kitchenTicket({ ...receipt, efris }, 'Africa/Kampala')).not.toContain('FDN');
  });
});
