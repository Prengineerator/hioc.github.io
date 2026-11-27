import { describe, expect, it } from 'vitest';
import {
  describePin,
  googleMapsEmbed,
  googleMapsLink,
  locationColumns,
  locationFromRow,
  parseShopLocation,
} from '@/lib/shop/location';
import { buildShiprocketOrder } from '@/lib/shop/shiprocket';
import { shopOrdersCsvTable } from '@/lib/shop/owner';
import { shopOrder } from './helpers/shopFixture';

// The optional delivery pin (lib/shop/location.ts): what checkout accepts, how
// it is stored, and that it reaches Shiprocket and the owner's sheet.

describe('parseShopLocation', () => {
  it('no pin is fine', () => {
    expect(parseShopLocation(undefined)).toEqual({ ok: true, location: null });
    expect(parseShopLocation(null)).toEqual({ ok: true, location: null });
  });

  it('keeps a GPS pin, rounded to 6 decimals, with its accuracy', () => {
    expect(parseShopLocation({ lat: 26.91243412, lng: 75.78727091, accuracy_m: 12.6, source: 'gps' })).toEqual({
      ok: true,
      location: { lat: 26.912434, lng: 75.787271, accuracy_m: 13, source: 'gps' },
    });
  });

  it('treats anything but gps as placed on the map', () => {
    const r = parseShopLocation({ lat: 27.2, lng: 78.0, source: 'satellite' });
    expect(r.ok && r.location).toEqual({ lat: 27.2, lng: 78, accuracy_m: null, source: 'map' });
  });

  it('refuses a pin outside India or one it cannot read', () => {
    expect(parseShopLocation({ lat: 51.5, lng: -0.12 }).ok).toBe(false);
    expect(parseShopLocation({ lat: '27.2', lng: '78.0' }).ok).toBe(false);
    expect(parseShopLocation({ lat: NaN, lng: 78 }).ok).toBe(false);
    expect(parseShopLocation('27.2,78.0').ok).toBe(false);
  });
});

describe('stored and shown', () => {
  const pin = { lat: 27.214438, lng: 78.021804, accuracy_m: 9, source: 'gps' as const };

  it('round-trips through the order columns (numerics may come back as text)', () => {
    expect(locationColumns(pin)).toEqual({ location_lat: 27.214438, location_lng: 78.021804, location_accuracy_m: 9, location_source: 'gps' });
    expect(locationColumns(null)).toEqual({ location_lat: null, location_lng: null, location_accuracy_m: null, location_source: null });
    expect(locationFromRow({ location_lat: '27.214438', location_lng: '78.021804', location_accuracy_m: 9, location_source: 'gps' })).toEqual(pin);
    expect(locationFromRow({ location_lat: null, location_lng: null })).toBeNull();
  });

  it('links to Google Maps without a key', () => {
    expect(googleMapsLink(pin)).toBe('https://www.google.com/maps?q=27.214438,78.021804');
    expect(googleMapsEmbed(pin)).toBe('https://www.google.com/maps?q=27.214438,78.021804&z=17&output=embed');
  });

  it('describes where the pin came from', () => {
    expect(describePin(pin)).toBe('GPS, within about 9 m');
    expect(describePin({ ...pin, accuracy_m: 1800 })).toBe('GPS, within about 1.8 km');
    expect(describePin({ ...pin, source: 'map' })).toBe('placed on the map');
  });

  it('goes to Shiprocket in the order comment', () => {
    const body = buildShiprocketOrder(shopOrder({ location_lat: '27.214438', location_lng: '78.021804', location_source: 'gps', location_accuracy_m: 9 }), { weight_kg: 0.7, length_cm: 20, breadth_cm: 12, height_cm: 10 }, 'Primary');
    expect(body.comment).toContain('Delivery pin: https://www.google.com/maps?q=27.214438,78.021804');
    const none = buildShiprocketOrder(shopOrder(), { weight_kg: 0.7, length_cm: 20, breadth_cm: 12, height_cm: 10 }, 'Primary');
    expect(none.comment).not.toContain('Delivery pin');
  });

  it('is a column in the owner’s CSV', () => {
    const t = shopOrdersCsvTable([shopOrder({ location_lat: 27.214438, location_lng: 78.021804, location_source: 'map' })]);
    const i = t.columns.indexOf('Map pin');
    expect(i).toBeGreaterThan(0);
    expect(t.rows[0][i]).toBe('https://www.google.com/maps?q=27.214438,78.021804');
  });
});
