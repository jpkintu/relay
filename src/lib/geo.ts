// Delivery distance, as the server works it out (cloud/lib/geo.js), so the
// customer sees the delivery charge before ordering.

export type LatLng = { lat: number; lng: number };

// Straight-line distance in km (haversine).
export function distanceKm(a: LatLng, b: LatLng) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// km (one decimal) × the rate per km.
export function feeByDistance(origin: LatLng, to: LatLng, perKm: number) {
  const km = Math.round(distanceKm(origin, to) * 10) / 10;
  return { km, fee: Math.round(km * perKm) };
}
