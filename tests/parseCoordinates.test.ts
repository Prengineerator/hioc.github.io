import { describe, it, expect } from 'vitest';
import { parseCoordinates } from '@/lib/attendance/parseCoordinates';

function ok(raw: string) {
  const r = parseCoordinates(raw);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`);
  return r.value;
}

describe('parseCoordinates — bare decimals (right-click → copy coordinates)', () => {
  it('parses the comma-separated pair Google puts on the clipboard', () => {
    expect(ok('28.613939, 77.209023')).toEqual({ lat: 28.613939, lng: 77.209023 });
  });

  it('parses without a space', () => {
    expect(ok('28.613939,77.209023')).toEqual({ lat: 28.613939, lng: 77.209023 });
  });

  it('parses a space-separated pair', () => {
    expect(ok('28.613939 77.209023')).toEqual({ lat: 28.613939, lng: 77.209023 });
  });

  it('handles negative coordinates', () => {
    expect(ok('-33.8688, 151.2093')).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(ok('40.7128, -74.006')).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(ok('  28.6, 77.2  ')).toEqual({ lat: 28.6, lng: 77.2 });
  });

  it('parses integers', () => {
    expect(ok('28, 77')).toEqual({ lat: 28, lng: 77 });
  });
});

describe('parseCoordinates — Google Maps URLs', () => {
  it('reads the @lat,lng from an address-bar copy', () => {
    expect(ok('https://www.google.com/maps/@28.613939,77.209023,17z')).toEqual({
      lat: 28.613939,
      lng: 77.209023,
    });
  });

  it('reads coordinates from a place URL', () => {
    const url =
      'https://www.google.com/maps/place/India+Gate/@28.612912,77.229510,17z/data=!3m1!4b1';
    expect(ok(url)).toEqual({ lat: 28.612912, lng: 77.22951 });
  });

  it('reads a ?q= pin', () => {
    expect(ok('https://maps.google.com/?q=28.613939,77.209023')).toEqual({
      lat: 28.613939,
      lng: 77.209023,
    });
  });

  it('prefers the pinned place over the map centre when both are present', () => {
    // The centre drifts as the owner pans; the pin is the place they chose.
    const url = 'https://www.google.com/maps/@10.0,20.0,17z?q=28.613939,77.209023';
    expect(ok(url)).toEqual({ lat: 28.613939, lng: 77.209023 });
  });

  it('explains what to do with a short share link instead of failing vaguely', () => {
    const r = parseCoordinates('https://maps.app.goo.gl/AbCdEf123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/right-click/i);
  });

  it('rejects a Maps URL with no coordinates in it, with guidance', () => {
    const r = parseCoordinates('https://www.google.com/maps/search/coffee');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/right-click/i);
  });
});

describe('parseCoordinates — degrees, minutes, seconds', () => {
  it('parses the DMS format shown in the Maps info panel', () => {
    const v = ok('28°36\'50.2"N 77°12\'32.5"E');
    expect(v.lat).toBeCloseTo(28.613944, 4);
    expect(v.lng).toBeCloseTo(77.209028, 4);
  });

  it('handles southern and western hemispheres as negative', () => {
    const v = ok('33°52\'7.7"S 151°12\'33.5"W');
    expect(v.lat).toBeLessThan(0);
    expect(v.lng).toBeLessThan(0);
  });

  it('parses a comma-separated DMS pair', () => {
    const v = ok('28°36\'50.2"N, 77°12\'32.5"E');
    expect(v.lat).toBeCloseTo(28.613944, 4);
  });
});

describe('parseCoordinates — rejections', () => {
  it('rejects empty input', () => {
    expect(parseCoordinates('').ok).toBe(false);
    expect(parseCoordinates('   ').ok).toBe(false);
  });

  it('rejects prose', () => {
    expect(parseCoordinates('the cafe on the corner').ok).toBe(false);
  });

  it('rejects a single number', () => {
    expect(parseCoordinates('28.613939').ok).toBe(false);
  });

  it('rejects out-of-range latitude', () => {
    const r = parseCoordinates('91.0, 77.2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/out of range/i);
  });

  it('rejects out-of-range longitude', () => {
    expect(parseCoordinates('28.6, 181.0').ok).toBe(false);
  });

  it('rejects three numbers', () => {
    expect(parseCoordinates('28.6, 77.2, 12.0').ok).toBe(false);
  });
});
