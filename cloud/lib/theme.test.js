import { describe, expect, test } from 'vitest';
import { themeProblems, cleanTheme, contrast } from './theme.js';

describe('restaurant theme colours', () => {
  test('the defaults and blank values pass', () => {
    expect(themeProblems({})).toEqual([]);
    expect(themeProblems({ ink: '#0b1633', accent: '#f14c1d' })).toEqual([]);
  });
  test('a dark green with a gold accent passes', () => {
    expect(themeProblems({ ink: '#123524', accent: '#e0a526' })).toEqual([]);
  });
  test('colours must be #rrggbb', () => {
    expect(themeProblems({ ink: 'green' })[0]).toMatch(/Main colour must look like/);
    expect(themeProblems({ accent: '#fff' })[0]).toMatch(/Accent colour must look like/);
  });
  test('a light main colour is refused', () => {
    expect(themeProblems({ ink: '#88aa88' })[0]).toMatch(/too light/);
  });
  test('an accent too close to the main colour is refused', () => {
    expect(themeProblems({ ink: '#0b1633', accent: '#1d2b55' })[0]).toMatch(/too close/);
  });
  test('values are tidied', () => {
    expect(cleanTheme({ ink: ' #0B1633 ', accent: null })).toEqual({ ink: '#0b1633', accent: '' });
  });
  test('contrast is symmetric', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
  });
});
