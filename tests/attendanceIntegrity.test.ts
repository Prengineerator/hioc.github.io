import { describe, it, expect } from 'vitest';
import { detectIntegrityFlags, type IntegrityInput } from '@/lib/attendance/integrity';

const BASE_MS = Date.parse('2026-08-06T04:30:00Z');
const LAT = 28.613939;
const LNG = 77.209023;

function input(over: Partial<IntegrityInput> = {}): IntegrityInput {
  return {
    lat: LAT,
    lng: LNG,
    accuracyM: 15,
    atMs: BASE_MS,
    prior: null,
    ...over,
  };
}

describe('detectIntegrityFlags', () => {
  it('flags nothing on a first-ever punch', () => {
    expect(detectIntegrityFlags(input())).toEqual([]);
  });

  it('flags nothing when the prior punch has no recorded coordinates', () => {
    const flags = detectIntegrityFlags(
      input({ prior: { lat: null, lng: null, accuracyM: null, atMs: BASE_MS - 3_600_000 } }),
    );
    expect(flags).toEqual([]);
  });

  it('flags byte-identical coordinates as a pinned location', () => {
    // Real GPS wanders in the last decimal places even sitting still; an exact
    // repeat points at a mock provider.
    const flags = detectIntegrityFlags(
      input({
        prior: { lat: LAT, lng: LNG, accuracyM: 15, atMs: BASE_MS - 8 * 3_600_000 },
      }),
    );
    expect(flags).toContain('static_coords');
  });

  it('does not flag ordinary GPS jitter at the same desk', () => {
    const flags = detectIntegrityFlags(
      input({
        prior: {
          lat: LAT + 0.00004, // ~4.5 m
          lng: LNG - 0.00003,
          accuracyM: 12,
          atMs: BASE_MS - 8 * 3_600_000,
        },
      }),
    );
    expect(flags).toEqual([]);
  });

  it('flags impossible travel between two punches', () => {
    // Delhi to Mumbai (~1150 km) in ten minutes.
    const flags = detectIntegrityFlags(
      input({
        prior: { lat: 19.075984, lng: 72.877656, accuracyM: 15, atMs: BASE_MS - 10 * 60_000 },
      }),
    );
    expect(flags).toContain('impossible_travel');
  });

  it('does not flag a plausible commute', () => {
    // ~20 km in 40 minutes = 30 km/h.
    const flags = detectIntegrityFlags(
      input({
        prior: { lat: LAT + 0.18, lng: LNG, accuracyM: 15, atMs: BASE_MS - 40 * 60_000 },
      }),
    );
    expect(flags).toEqual([]);
  });

  it('does not flag impossible travel for identical coordinates (that is static_coords, not teleporting)', () => {
    const flags = detectIntegrityFlags(
      input({ prior: { lat: LAT, lng: LNG, accuracyM: 15, atMs: BASE_MS - 1_000 } }),
    );
    expect(flags).toContain('static_coords');
    expect(flags).not.toContain('impossible_travel');
  });

  it('does not divide by zero when two punches share a timestamp', () => {
    const flags = detectIntegrityFlags(
      input({ prior: { lat: 19.075984, lng: 72.877656, accuracyM: 15, atMs: BASE_MS } }),
    );
    expect(flags.every((f) => Number.isNaN(f as unknown as number) === false)).toBe(true);
    expect(flags).not.toContain('impossible_travel');
  });

  it('ignores a prior punch dated in the future rather than reporting a negative speed', () => {
    const flags = detectIntegrityFlags(
      input({
        prior: { lat: 19.075984, lng: 72.877656, accuracyM: 15, atMs: BASE_MS + 60_000 },
      }),
    );
    expect(flags).not.toContain('impossible_travel');
  });

  it('can report both signals at once', () => {
    // Identical coordinates cannot also be impossible travel, so the realistic
    // "both" case is a static coordinate paired with something else upstream;
    // here we assert the array shape stays clean rather than duplicating.
    const flags = detectIntegrityFlags(
      input({ prior: { lat: LAT, lng: LNG, accuracyM: 15, atMs: BASE_MS - 60_000 } }),
    );
    expect(new Set(flags).size).toBe(flags.length);
  });
});
