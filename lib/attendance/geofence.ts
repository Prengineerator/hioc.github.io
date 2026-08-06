// GEO-1 — the geofence verdict. Pure, so it is fully testable and so the
// decision has exactly one implementation.
//
// THE CLIENT NEVER DECIDES. It sends raw readings; this runs on the server and
// says yes or no (SECURITY-PLAYBOOK A-2). If a request body ever carries a
// distance or a verdict, drop it — do not validate it and then trust it.
//
// Stated plainly, because it shapes what this can and cannot promise: browser
// geolocation is spoofable. DevTools overrides it in two clicks and Android
// mock-location apps do it system-wide, and no web API detects either. What
// follows stops honest error — bad indoor fixes, stale cached positions,
// someone punching from the bus stop — and makes deliberate cheating leave a
// pattern (see integrity.ts). It is not a proof of presence, and the product
// must not imply that it is.

import type { AttendanceFlag } from '@/lib/types';

export interface GeoReading {
  lat: number;
  lng: number;
  /** Radius of 68% confidence in metres, as reported by the Geolocation API. */
  accuracyM: number;
  /** How old the fix was when it was sent, in ms. Guards against a replayed cache. */
  fixAgeMs: number;
}

export interface GeofenceConfig {
  /** null until the owner configures the cafe — which disables punching. */
  storeLat: number | null;
  storeLng: number | null;
  radiusM: number;
  maxAccuracyM: number;
  maxFixAgeSec: number;
}

export type GeofenceCode =
  | 'ok'
  | 'ok_low_confidence'
  | 'not_configured'
  | 'invalid_reading'
  | 'inaccurate'
  | 'stale'
  | 'outside';

export interface GeofenceVerdict {
  accepted: boolean;
  code: GeofenceCode;
  /** Null when no distance could be computed (unconfigured or unusable reading). */
  distanceM: number | null;
  /** Shown to the staffer verbatim. Says what to DO, not just what went wrong. */
  reason: string;
  flags: AttendanceFlag[];
}

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean earth radius

/**
 * Great-circle distance in metres between two WGS-84 points.
 *
 * Haversine rather than the cheaper equirectangular approximation: at cafe
 * scale both are accurate to well under a metre, but haversine has no latitude
 * term to get wrong and its error does not grow if this is ever reused for
 * something further apart.
 */
export function haversineMetres(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isUsableNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Rejects the shapes a hostile or broken client can send: NaN, strings, out-of-range. */
export function isValidReading(reading: GeoReading): boolean {
  return (
    isUsableNumber(reading.lat) &&
    isUsableNumber(reading.lng) &&
    isUsableNumber(reading.accuracyM) &&
    isUsableNumber(reading.fixAgeMs) &&
    reading.lat >= -90 &&
    reading.lat <= 90 &&
    reading.lng >= -180 &&
    reading.lng <= 180 &&
    reading.accuracyM > 0 &&
    reading.fixAgeMs >= 0
  );
}

/**
 * Decide whether a punch may be recorded.
 *
 * The ladder, in order, and why each rung exists:
 *
 *  1. **Store not configured** → refuse. There is no safe default for "where is
 *     the cafe"; treating an unset location as "anywhere is fine" would silently
 *     accept every punch on earth.
 *  2. **Unusable reading** → refuse.
 *  3. **Too imprecise** → refuse. A ±2km accuracy circle whose centre happens to
 *     land inside a 150m radius proves nothing, and accepting it would make the
 *     geofence decorative.
 *  4. **Stale fix** → refuse. An old cached position is the easiest thing to
 *     replay, and `maximumAge: 0` on the client is a request, not a guarantee.
 *  5. **Definitively outside** (`distance − accuracy > radius`) → refuse. Even
 *     granting the reading the full benefit of its own error bar, they are not here.
 *  6. **Inside** (`distance ≤ radius`) → accept.
 *  7. **Ambiguous** (outside the radius but inside the error bar) → ACCEPT and
 *     flag `low_confidence`. A marginal GPS reading should not cost someone a
 *     day's pay; it should cost them a line the owner can look at.
 */
export function evaluateGeofence(
  reading: GeoReading,
  config: GeofenceConfig,
): GeofenceVerdict {
  if (config.storeLat === null || config.storeLng === null) {
    return {
      accepted: false,
      code: 'not_configured',
      distanceM: null,
      reason:
        "The cafe's location hasn't been set up yet, so attendance can't be marked. Ask the owner to set it in Settings.",
      flags: [],
    };
  }

  if (!isValidReading(reading)) {
    return {
      accepted: false,
      code: 'invalid_reading',
      distanceM: null,
      reason: "We couldn't read a usable location from your device. Try again.",
      flags: [],
    };
  }

  const flags: AttendanceFlag[] = [];
  // Consumer GPS does not do sub-metre. A reading that claims to is either a
  // mock provider or a broken one; either way it is worth a look, and neither
  // is worth blocking an otherwise-valid punch over.
  if (reading.accuracyM < 1) flags.push('implausible_accuracy');

  if (reading.accuracyM > config.maxAccuracyM) {
    return {
      accepted: false,
      code: 'inaccurate',
      distanceM: null,
      reason: `We couldn't get a precise enough location (±${Math.round(reading.accuracyM)} m). Step near a window or just outside, then try again.`,
      flags,
    };
  }

  if (reading.fixAgeMs > config.maxFixAgeSec * 1000) {
    return {
      accepted: false,
      code: 'stale',
      distanceM: null,
      reason: 'That location reading was out of date. Try again.',
      flags,
    };
  }

  const distanceM = haversineMetres(
    config.storeLat,
    config.storeLng,
    reading.lat,
    reading.lng,
  );
  const rounded = Math.round(distanceM * 100) / 100;

  if (distanceM - reading.accuracyM > config.radiusM) {
    return {
      accepted: false,
      code: 'outside',
      distanceM: rounded,
      reason: `You're about ${formatDistance(distanceM)} from the cafe. Attendance can only be marked at the cafe.`,
      flags,
    };
  }

  if (distanceM <= config.radiusM) {
    return { accepted: true, code: 'ok', distanceM: rounded, reason: '', flags };
  }

  return {
    accepted: true,
    code: 'ok_low_confidence',
    distanceM: rounded,
    reason: '',
    flags: [...flags, 'low_confidence'],
  };
}

/** Whole metres under a km, one decimal km above — nobody needs "1043 m". */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
