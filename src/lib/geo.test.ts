import { describe, expect, it } from 'vitest';
import { distanceKm, feeByDistance } from './geo';

describe('delivery distance', () => {
  it('measures the straight line between two pins', () => {
    // Kampala centre to Ntinda: about 5.9 km.
    const km = distanceKm({ lat: 0.3136, lng: 32.5811 }, { lat: 0.3543, lng: 32.6146 });
    expect(km).toBeGreaterThan(5.8);
    expect(km).toBeLessThan(6.0);
    expect(distanceKm({ lat: 1, lng: 1 }, { lat: 1, lng: 1 })).toBe(0);
  });

  it('charges km to one decimal times the rate', () => {
    const origin = { lat: 0.3136, lng: 32.5811 };
    // 0.027 degrees of latitude ≈ 3.0 km.
    expect(feeByDistance(origin, { lat: 0.3406, lng: 32.5811 }, 1000)).toEqual({
      km: 3,
      fee: 3000,
    });
    expect(feeByDistance(origin, origin, 1000)).toEqual({ km: 0, fee: 0 });
  });
});
