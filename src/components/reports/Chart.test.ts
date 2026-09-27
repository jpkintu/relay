import { describe, expect, test } from 'vitest';
import { recolor } from './Chart';

describe('chart colours follow the branding', () => {
  test("Relay's colours are swapped, everything else is kept", () => {
    const map = { '#0751f0': '#123524', '#f14c1d': '#e0a526', '#0b1633': '#123524' };
    const data = [
      { x: [1, 2], y: ['a', 'b'], marker: { color: ['#0751F0', '#1baf7a'] } },
      { line: { color: '#f14c1d' }, textfont: { color: '#0b1633', size: 12 } },
    ];
    expect(recolor(data, map)).toEqual([
      { x: [1, 2], y: ['a', 'b'], marker: { color: ['#123524', '#1baf7a'] } },
      { line: { color: '#e0a526' }, textfont: { color: '#123524', size: 12 } },
    ]);
  });
  test('nothing changes without a custom theme', () => {
    const data = [{ marker: { color: '#0751f0' } }];
    expect(recolor(data, {})).toEqual(data);
  });
});
