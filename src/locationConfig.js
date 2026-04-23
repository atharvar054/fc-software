// Manual location override for route and marker testing.
// Edit latitude/longitude here when you want to test a specific coordinate.
// Set enabled=false to use Firestore locations as-is.
export const MANUAL_LOCATION_OVERRIDE = {
  enabled: false,
  personID: '', // Keep null to apply for all persons.
  latitude: 19.045667326361578,
  longitude: 72.90301909402771,
  locationName: 'Cubic mall',
};

export function isValidLatLng(loc) {
  return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) &&
    loc.lat >= -90 && loc.lat <= 90 && loc.lng >= -180 && loc.lng <= 180;
}

export function extractLatLng(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && 'lat' in raw && 'lng' in raw) {
    return { lat: Number(raw.lat), lng: Number(raw.lng) };
  }
  if (typeof raw === 'object' && 'latitude' in raw && 'longitude' in raw) {
    return { lat: Number(raw.latitude), lng: Number(raw.longitude) };
  }
  return null;
}

export function normalizeAlertLocation(location, fallback = null) {
  const parsed = extractLatLng(location);
  return isValidLatLng(parsed) ? parsed : fallback;
}

export function getManualLocationOverride(personID) {
  if (!MANUAL_LOCATION_OVERRIDE.enabled) return null;

  const targetPersonId = MANUAL_LOCATION_OVERRIDE.personID;
  if (targetPersonId && targetPersonId !== personID) return null;

  const manualLocation = {
    lat: Number(MANUAL_LOCATION_OVERRIDE.latitude),
    lng: Number(MANUAL_LOCATION_OVERRIDE.longitude),
  };

  if (!isValidLatLng(manualLocation)) return null;

  return {
    location: manualLocation,
    locationName: MANUAL_LOCATION_OVERRIDE.locationName || null,
  };
}

export function resolveAlertLocation({ personID, location, locationName }) {
  const manual = getManualLocationOverride(personID);
  if (manual) return manual;

  return {
    location: normalizeAlertLocation(location),
    locationName: typeof locationName === 'string'
      ? locationName
      : (typeof location === 'string' ? location : null),
  };
}
