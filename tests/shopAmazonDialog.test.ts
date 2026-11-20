import { describe, expect, it } from 'vitest';
import { formatDeliveryBy, isAmazonBookingHeld, isPriceListStale, labelBlobFromBase64, readRatesAnswer } from '@/lib/shop/amazonDialog';

const P = { weight_kg: '0.5', length_cm: '20', breadth_cm: '15', height_cm: '10' };

describe('formatDeliveryBy', () => {
  it('shows the weekday and date in IST', () => {
    // 20:00 UTC on 23 Nov is already 24 Nov (a Tuesday) in India.
    expect(formatDeliveryBy('2026-11-23T20:00:00Z')).toBe('by Tue 24 Nov');
    expect(formatDeliveryBy('2026-11-22T10:00:00+05:30')).toBe('by Sun 22 Nov');
  });
  it('says so when Amazon gave no date', () => {
    expect(formatDeliveryBy(null)).toBe('delivery date not given');
    expect(formatDeliveryBy('')).toBe('delivery date not given');
    expect(formatDeliveryBy('nonsense')).toBe('delivery date not given');
  });
});

describe('isPriceListStale', () => {
  it('is stale with no priced parcel and when any field differs', () => {
    expect(isPriceListStale(null, P)).toBe(true);
    expect(isPriceListStale(P, { ...P })).toBe(false);
    expect(isPriceListStale(P, { ...P, weight_kg: '0.6' })).toBe(true);
    expect(isPriceListStale(P, { ...P, height_cm: '11' })).toBe(true);
  });
  it('ignores stray spaces', () => {
    expect(isPriceListStale(P, { ...P, length_cm: ' 20 ' })).toBe(false);
  });
});

describe('readRatesAnswer', () => {
  it('keeps usable rows, cheapest first, and the priced parcel', () => {
    const out = readRatesAnswer({
            rates: [
        { rateId: 'b', quote: 'qb', serviceName: 'Express', chargeInr: 95, deliveryBy: '2026-11-22T10:00:00Z' },
        { rateId: 'a', quote: 'qa', serviceName: 'Standard', chargeInr: 62, deliveryBy: null },
        { serviceName: 'no id', chargeInr: 1 },
        { rateId: 'c', serviceName: 'no quote', chargeInr: 1 },
      ],
      parcel: { weight_kg: 0.5, length_cm: 20, breadth_cm: 15, height_cm: 10 },
    });
    expect(out.rates[0].quote).toBe('qa');
    expect(out.rates.map((r) => r.rateId)).toEqual(['a', 'b']);
    expect(out.parcel).toEqual(P);
  });
  it('copes with junk', () => {
    expect(readRatesAnswer(null)).toEqual({ rates: [], parcel: null });
  });
});

describe('labelBlobFromBase64', () => {
  it('makes a PDF blob, or null for bad input', async () => {
    const b = labelBlobFromBase64(Buffer.from('%PDF-1.4').toString('base64'));
    expect(b?.type).toBe('application/pdf');
    expect(b?.size).toBe(8);
    expect(labelBlobFromBase64('')).toBeNull();
    expect(labelBlobFromBase64('***')).toBeNull();
  });
});

describe('isAmazonBookingHeld', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  it('is true only for a paid order with a far-future claim', () => {
    expect(isAmazonBookingHeld({ status: 'paid', amazon_booking_at: '2099-01-01T00:00:00Z' }, now)).toBe(true);
    expect(isAmazonBookingHeld({ status: 'paid', amazon_booking_at: '2026-11-20T09:59:00Z' }, now)).toBe(false);
    expect(isAmazonBookingHeld({ status: 'paid', amazon_booking_at: null }, now)).toBe(false);
    expect(isAmazonBookingHeld({ status: 'shipped', amazon_booking_at: '2099-01-01T00:00:00Z' }, now)).toBe(false);
  });
});
