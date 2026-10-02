import { describe, expect, test } from 'vitest';
import { flierCss, flierHtml, tableCardsHtml, type Flier } from './flier';

const base: Flier = {
  size: 'a4',
  restaurant: 'Mama <Rose> & Co',
  logo: '',
  qr: 'data:image/png;base64,AAAA',
  link: 'https://mama-rose.relayeats.app/order',
  headline: 'Order online',
  subline: 'Scan to see our live menu',
  modes: 'Pick-up · Delivery',
  payments: 'Cash · MTN MoMo',
  note: '',
  ink: '#112233',
  accent: 'not-a-colour',
};

describe('QR fliers', () => {
  test('a flier names the restaurant safely and shows the link without https', () => {
    const html = flierHtml(base);
    expect(html).toContain('Mama &lt;Rose&gt; &amp; Co');
    expect(html).toContain('mama-rose.relayeats.app/order');
    expect(html).not.toContain('https://mama-rose');
    expect(html.match(/class="flier"/g)).toHaveLength(1);
  });

  test('table cards print four to an A4 page; A5 fliers on A5', () => {
    expect(flierHtml({ ...base, size: 'cards' }).match(/class="flier"/g)).toHaveLength(4);
    expect(flierCss({ size: 'a5', ink: '', accent: '' })).toContain('size: A5');
    expect(flierCss({ size: 'cards', ink: '', accent: '' })).toContain('size: A4');
  });

  test('bad colours fall back to RelayEats colours', () => {
    const css = flierCss(base);
    expect(css).toContain('#112233');
    expect(css).toContain('#f14c1d');
  });

  test('table cards: one per table with its own QR code, four to a page', () => {
    const tables = Array.from({ length: 5 }, (_, i) => ({
      name: `Table ${i + 1}`,
      qr: `data:image/png;base64,T${i}`,
    }));
    const html = tableCardsHtml(base, tables);
    expect(html.match(/class="sheet cards"/g)).toHaveLength(2);
    expect(html.match(/class="flier"/g)).toHaveLength(5);
    expect(html).toContain('Table 5');
    expect(html).toContain('base64,T4');
    expect(html).not.toContain('class="link"');
  });
});
