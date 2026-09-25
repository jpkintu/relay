import { expect, test } from 'vitest';
import { deviceFor } from './device';

test('deviceFor maps widths to device classes', () => {
  expect(deviceFor(360)).toBe('phone');
  expect(deviceFor(599)).toBe('phone');
  expect(deviceFor(600)).toBe('tablet');
  expect(deviceFor(1023)).toBe('tablet');
  expect(deviceFor(1024)).toBe('laptop');
  expect(deviceFor(1599)).toBe('laptop');
  expect(deviceFor(1920)).toBe('monitor');
});
