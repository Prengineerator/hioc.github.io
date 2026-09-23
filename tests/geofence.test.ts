import { describe, it, expect } from 'vitest';
import {
  evaluateGeofence,
  haversineMetres,
  isValidReading,
  formatDistance,
  type GeoReading,
  type GeofenceConfig,
} from '@/lib/attendance/geofence';

// A plausible cafe location. Coordinates below are derived from it by offsetting
// latitude, where 1 degree ≈ 111.32 km, so the expected distances are arithmetic
// rather than magic numbers.
const STORE_LAT = 28.613939;
const STORE_LNG = 77.209023;
const M_PER_DEG_LAT = 111_320;

function config(over: Partial<GeofenceConfig> = {}): GeofenceConfig {
  return {
    storeLat: STORE_LAT,
    storeLng: STORE_LNG,
    radiusM: 150,
    maxAccuracyM: 100,
    maxFixAgeSec: 60,
    ...over,
  };
}

function readingAtMetresNorth(metres: number, over: Partial<GeoReading> = {}): GeoReading {
  return {
    lat: STORE_LAT + metres / M_PER_DEG_LAT,
    lng: STORE_LNG,
    accuracyM: 20,
    fixAgeMs: 1_000,
    ...over,
  };
}

describe('haversineMetres', () => {
  it('is zero for the same point', () => {
    expect(haversineMetres(STORE_LAT, STORE_LNG, STORE_LAT, STORE_LNG)).toBe(0);
  });

  it('matches a known latitude offset to within a metre', () => {
    const d = haversineMetres(STORE_LAT, STORE_LNG, STORE_LAT + 1 / M_PER_DEG_LAT * 100, STORE_LNG);
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });

  it('is symmetric', () => {
    const a = haversineMetres(28.6, 77.2, 19.076, 72.877);
    const b = haversineMetres(19.076, 72.877, 28.6, 77.2);
    expect(a).toBeCloseTo(b, 6);
  });

  it('computes a long real-world distance correctly (Delhi–Mumbai ≈ 1150 km)', () => {
    const km = haversineMetres(28.613939, 77.209023, 19.075984, 72.877656) / 1000;
    expect(km).toBeGreaterThan(1130);
    expect(km).toBeLessThan(1170);
  });

  it('does not return NaN for antipodal points', () => {
    // The sqrt argument can drift above 1 through floating-point error; if it
    // were not clamped, asin() would return NaN and every verdict downstream
    // would silently become "not outside".
    expect(Number.isFinite(haversineMetres(0, 0, 0, 180))).toBe(true);
    expect(Number.isFinite(haversineMetres(90, 0, -90, 0))).toBe(true);
  });
});

describe('isValidReading', () => {
  it('accepts a normal reading', () => {
    expect(isValidReading(readingAtMetresNorth(10))).toBe(true);
  });

  it.each([
    ['NaN latitude', { lat: NaN }],
    ['infinite longitude', { lng: Infinity }],
    ['latitude out of range', { lat: 91 }],
    ['longitude out of range', { lng: -181 }],
    ['zero accuracy', { accuracyM: 0 }],
    ['negative accuracy', { accuracyM: -5 }],
    ['negative fix age', { fixAgeMs: -1 }],
  ])('rejects %s', (_label, over) => {
    expect(isValidReading(readingAtMetresNorth(10, over as Partial<GeoReading>))).toBe(false);
  });

  it('rejects a non-numeric value smuggled in as a string', () => {
    const hostile = { lat: '28.6', lng: 77.2, accuracyM: 10, fixAgeMs: 0 } as unknown as GeoReading;
    expect(isValidReading(hostile)).toBe(false);
  });
});

describe('evaluateGeofence', () => {
  it('refuses when the store location is not configured, rather than accepting everything', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5), config({ storeLat: null, storeLng: null }));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('not_configured');
    expect(v.distanceM).toBeNull();
    expect(v.reason).toMatch(/owner/i);
  });

  it('refuses only a half-configured store location', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5), config({ storeLng: null }));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('not_configured');
  });

  it('accepts a precise fix inside the radius', () => {
    const v = evaluateGeofence(readingAtMetresNorth(50), config());
    expect(v.accepted).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.flags).toEqual([]);
    expect(v.distanceM).toBeGreaterThan(45);
    expect(v.distanceM).toBeLessThan(55);
  });

  it('accepts a punch from exactly the store point', () => {
    const v = evaluateGeofence(readingAtMetresNorth(0), config());
    expect(v.accepted).toBe(true);
    expect(v.distanceM).toBe(0);
  });

  it('refuses an imprecise fix even when its centre lands inside the radius', () => {
    // The whole point: a ±2 km circle centred on the counter proves nothing.
    const v = evaluateGeofence(readingAtMetresNorth(5, { accuracyM: 2000 }), config());
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('inaccurate');
    expect(v.reason).toMatch(/window|outside/i);
    expect(v.reason).toContain('2000');
  });

  it('refuses a stale fix', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5, { fixAgeMs: 61_000 }), config());
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('stale');
  });

  it('accepts a fix exactly at the staleness limit', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5, { fixAgeMs: 60_000 }), config());
    expect(v.accepted).toBe(true);
  });

  it('accepts a fix exactly at the accuracy limit', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5, { accuracyM: 100 }), config());
    expect(v.accepted).toBe(true);
  });

  it('refuses a punch that is definitively outside even allowing for its error bar', () => {
    const v = evaluateGeofence(readingAtMetresNorth(1000, { accuracyM: 20 }), config());
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('outside');
    expect(v.reason).toMatch(/99\d m/);
    // The distance is still recorded, so a pattern of far-away attempts is legible.
    expect(v.distanceM).toBeGreaterThan(990);
  });

  it('accepts but flags an ambiguous punch just outside the radius', () => {
    // 200 m out with ±80 m accuracy: outside the 150 m radius, but the error bar
    // reaches inside it. Refusing would cost an honest staffer their day.
    const v = evaluateGeofence(readingAtMetresNorth(200, { accuracyM: 80 }), config());
    expect(v.accepted).toBe(true);
    expect(v.code).toBe('ok_low_confidence');
    expect(v.flags).toContain('low_confidence');
  });

  it('refuses once the error bar no longer reaches the radius', () => {
    const v = evaluateGeofence(readingAtMetresNorth(300, { accuracyM: 80 }), config());
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('outside');
  });

  it('flags an implausibly precise reading without blocking it', () => {
    const v = evaluateGeofence(readingAtMetresNorth(10, { accuracyM: 0.5 }), config());
    expect(v.accepted).toBe(true);
    expect(v.flags).toContain('implausible_accuracy');
  });

  it('carries the implausible-accuracy flag through onto a refusal', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5000, { accuracyM: 0.5 }), config());
    expect(v.accepted).toBe(false);
    expect(v.flags).toContain('implausible_accuracy');
  });

  it('refuses an unusable reading before it can reach the distance maths', () => {
    const v = evaluateGeofence(readingAtMetresNorth(5, { lat: NaN }), config());
    expect(v.accepted).toBe(false);
    expect(v.code).toBe('invalid_reading');
    expect(v.distanceM).toBeNull();
  });

  it('honours a widened radius', () => {
    const reading = readingAtMetresNorth(400, { accuracyM: 10 });
    expect(evaluateGeofence(reading, config()).accepted).toBe(false);
    expect(evaluateGeofence(reading, config({ radiusM: 500 })).accepted).toBe(true);
  });

  it('never leaks the configured radius or store point in what the staffer is told', () => {
    // Playbook A-3: a staffer who learns the radius learns most of what they
    // need to beat it.
    const v = evaluateGeofence(readingAtMetresNorth(5000), config());
    expect(v.reason).not.toContain('150');
    expect(v.reason).not.toContain(String(STORE_LAT));
    expect(v.reason).not.toContain(String(STORE_LNG));
    expect(JSON.stringify(v)).not.toContain(String(STORE_LAT));
  });
});

describe('formatDistance', () => {
  it('uses whole metres below a kilometre', () => {
    expect(formatDistance(143.7)).toBe('144 m');
  });

  it('uses one decimal kilometre above', () => {
    expect(formatDistance(1043)).toBe('1.0 km');
    expect(formatDistance(12_500)).toBe('12.5 km');
  });
});
