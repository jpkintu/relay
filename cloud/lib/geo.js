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

module.exports = { cleanLocation };
