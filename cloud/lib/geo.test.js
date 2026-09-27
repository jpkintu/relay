import { describe, expect, test } from 'vitest';
import { cleanLocation } from './geo.js';

describe('cleanLocation', () => {
  test('no pin is fine', () => {
    expect(cleanLocation(undefined)).toEqual({ location: null });
    expect(cleanLocation(null)).toEqual({ location: null });
  });
  test('rounds a valid pin', () => {
    expect(cleanLocation({ lat: 0.34761234567, lng: '32.58251234' })).toEqual({
      location: { lat: 0.347612, lng: 32.582512 },
    });
  });
  test('rejects nonsense', () => {
    expect(cleanLocation({ lat: 91, lng: 0 }).error).toBeTruthy();
    expect(cleanLocation({ lat: 'x', lng: 1 }).error).toBeTruthy();
    expect(cleanLocation({ lat: 0, lng: 0 }).error).toBeTruthy();
  });
});
