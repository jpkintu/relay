// Delivery pins. A location travels as { lat, lng } (decimal degrees).

// A valid { lat, lng } rounded to ~10 cm, null when none was given, or an
// error message.
function cleanLocation(value) {
  if (value === undefined || value === null || value === '') return { location: null };
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return { error: 'That map pin is not a valid location' };
  if (lat === 0 && lng === 0) return { error: 'Drop the pin on the delivery address' };
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return { location: { lat: round(lat), lng: round(lng) } };
}

// Straight-line distance in km between two { lat, lng } (haversine).
function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// A delivery charged by distance: km (one decimal) × the rate per km.
// src/lib/geo.ts shows customers the same figure before they order.
function feeByDistance(origin, to, perKm) {
  const km = Math.round(distanceKm(origin, to) * 10) / 10;
  return { km, fee: Math.round(km * perKm) };
}

// A stored pin ({ lat, lng } numbers), or null.
function pinOf(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && (a !== 0 || b !== 0)
    ? { lat: a, lng: b }
    : null;
}

module.exports = { cleanLocation, distanceKm, feeByDistance, pinOf };
