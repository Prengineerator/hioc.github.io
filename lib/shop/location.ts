// The delivery pin for an Instant Coffee order (docs/INSTANT-COFFEE-SHOP.md).
// Pure, shared by the /shop form and POST /api/shop/checkout.
//
// The customer may pin where the parcel should go: "Use my current location"
// (the phone's GPS) and, when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set, a Google
// Map whose pin they can drag to the exact door. It is optional (people order
// for other addresses), stored on the order, shown to the owner as a Google
// Maps link and sent to Shiprocket with the order, so a courier who can't find
// the address has the exact spot: fewer failed deliveries (RTO).

export type LocationSource = 'gps' | 'map';

export interface ShopLocation {
  lat: number;
  lng: number;
  /** The phone's own estimate in metres (GPS only). */
  accuracy_m: number | null;
  /** 'gps' straight from the phone, 'map' once placed or moved on the map. */
  source: LocationSource;
}

/** Roughly India, islands included: a pin outside it is a mistake. */
const INDIA = { latMin: 6, latMax: 38, lngMin: 68, lngMax: 98 };

/** A phone's GPS fix this vague (metres) is worth a gentle warning. */
export const VAGUE_ACCURACY_M = 250;

export type LocationResult = { ok: true; location: ShopLocation | null } | { ok: false; error: string };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The request's `location` → a clean pin, or null when none was given. A pin
 * must have finite coordinates inside India; accuracy is optional.
 */
export function parseShopLocation(raw: unknown): LocationResult {
  if (raw === undefined || raw === null) return { ok: true, location: null };
  if (typeof raw !== 'object') return { ok: false, error: 'The location pin could not be read — remove it and try again.' };
  const r = raw as Record<string, unknown>;
  const lat = typeof r.lat === 'number' ? r.lat : NaN;
  const lng = typeof r.lng === 'number' ? r.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'The location pin could not be read — remove it and try again.' };
  }
  if (lat < INDIA.latMin || lat > INDIA.latMax || lng < INDIA.lngMin || lng > INDIA.lngMax) {
    return { ok: false, error: 'That pin is outside India — move it to the delivery address, or remove it.' };
  }
  const acc = typeof r.accuracy_m === 'number' && Number.isFinite(r.accuracy_m) && r.accuracy_m >= 0 ? Math.round(Math.min(r.accuracy_m, 100000)) : null;
  const source: LocationSource = r.source === 'gps' ? 'gps' : 'map';
  return { ok: true, location: { lat: round6(lat), lng: round6(lng), accuracy_m: acc, source } };
}

/** The pin as stored on shop_orders. */
export function locationColumns(loc: ShopLocation | null): Record<string, unknown> {
  return {
    location_lat: loc?.lat ?? null,
    location_lng: loc?.lng ?? null,
    location_accuracy_m: loc?.accuracy_m ?? null,
    location_source: loc?.source ?? null,
  };
}

/** The stored columns → a pin, or null. Postgres numerics may arrive as text. */
export function locationFromRow(row: {
  location_lat?: unknown;
  location_lng?: unknown;
  location_accuracy_m?: unknown;
  location_source?: unknown;
}): ShopLocation | null {
  const lat = row.location_lat === null || row.location_lat === undefined ? NaN : Number(row.location_lat);
  const lng = row.location_lng === null || row.location_lng === undefined ? NaN : Number(row.location_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const acc = row.location_accuracy_m === null || row.location_accuracy_m === undefined ? null : Number(row.location_accuracy_m);
  return {
    lat,
    lng,
    accuracy_m: acc !== null && Number.isFinite(acc) ? acc : null,
    source: row.location_source === 'gps' ? 'gps' : 'map',
  };
}

/** Opens the pin in Google Maps (app or browser); no API key needed. */
export function googleMapsLink(loc: Pick<ShopLocation, 'lat' | 'lng'>): string {
  return `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
}

/** The keyless embed (as on the Contact page): a read-only map with the pin. */
export function googleMapsEmbed(loc: Pick<ShopLocation, 'lat' | 'lng'>): string {
  return `https://www.google.com/maps?q=${loc.lat},${loc.lng}&z=17&output=embed`;
}

/** "GPS, within about 12 m" / "placed on the map" */
export function describePin(loc: ShopLocation): string {
  if (loc.source === 'map') return 'placed on the map';
  if (loc.accuracy_m === null) return 'from GPS';
  return loc.accuracy_m >= 1000
    ? `GPS, within about ${(loc.accuracy_m / 1000).toFixed(1)} km`
    : `GPS, within about ${loc.accuracy_m} m`;
}
