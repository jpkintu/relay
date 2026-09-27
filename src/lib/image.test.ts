import { describe, expect, test } from 'vitest';
import { findContent } from './image';

// A width×height RGBA image, white, with one dark block.
function image(width: number, height: number, block: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const [bx, by, bw, bh] = block;
  for (let y = by; y < by + bh; y++)
    for (let x = bx; x < bx + bw; x++) data.set([20, 90, 40, 255], (y * width + x) * 4);
  return data;
}

describe('logo trimming', () => {
  test('cuts white margins down to the drawing, with a small edge', () => {
    const box = findContent(image(100, 100, [30, 20, 40, 10]), 100, 100);
    expect(box).toEqual({ x: 28, y: 18, width: 44, height: 14 });
  });
  test('transparent pixels count as margin', () => {
    const data = image(50, 50, [10, 10, 5, 5]);
    for (let i = 0; i < 50 * 5 * 4; i += 4) data[i + 3] = 0;
    for (let i = 0; i < 50 * 5 * 4; i += 4) data[i] = 0;
    expect(findContent(data, 50, 50)).toEqual({ x: 9, y: 9, width: 7, height: 7 });
  });
  test('an all-white image is left alone', () => {
    expect(findContent(new Uint8ClampedArray(10 * 10 * 4).fill(255), 10, 10)).toBeNull();
  });
});
