import { describe, expect, test } from 'vitest';
import { contrast, onAccent, themeProblems } from './theme';

describe('theme colours (client copy of the server rules)', () => {
  test('defaults and a dark green with gold pass', () => {
    expect(themeProblems({})).toEqual([]);
    expect(themeProblems({ ink: '#123524', accent: '#e0a526' })).toEqual([]);
  });
  test('bad values, light main colours and dull accents are refused', () => {
    expect(themeProblems({ ink: 'green' })[0]).toMatch(/must look like/);
    expect(themeProblems({ ink: '#88aa88' })[0]).toMatch(/too light/);
    expect(themeProblems({ accent: '#1d2b55' })[0]).toMatch(/too close/);
  });
  test('contrast of black on white is 21', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  test('text on the accent is whichever of white or the main colour reads better', () => {
    expect(onAccent({})).toBe('#0b1633');
    expect(onAccent({ ink: '#123524', accent: '#e0a526' })).toBe('#123524');
    expect(onAccent({ ink: '#000000', accent: '#8b0000' })).toBe('#ffffff');
    for (const theme of [{}, { ink: '#123524', accent: '#e0a526' }])
      expect(contrast(onAccent(theme), theme.accent || '#f14c1d')).toBeGreaterThanOrEqual(4.5);
  });
});
