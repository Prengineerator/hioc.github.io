import { describe, expect, it } from 'vitest';
import { normalizeLegacyPhone } from '@/lib/petpooja/phone';

// Stricter than lib/phone.ts's normalizeIndianMobile — see lib/petpooja/phone.ts.
// All numbers here are invented (no real customer data).
describe('normalizeLegacyPhone', () => {
  it('accepts a bare 10-digit mobile, as a number or a string', () => {
    expect(normalizeLegacyPhone(9876500001)).toBe('+919876500001');
    expect(normalizeLegacyPhone('9876500001')).toBe('+919876500001');
  });

  it('accepts a +91-prefixed number', () => {
    expect(normalizeLegacyPhone('+919876500001')).toBe('+919876500001');
  });

  it('accepts a bare 91-prefixed 12-digit number', () => {
    expect(normalizeLegacyPhone('919876500001')).toBe('+919876500001');
  });

  it('strips a leading apostrophe (CSV text-forced phone column)', () => {
    expect(normalizeLegacyPhone("'9876500001")).toBe('+919876500001');
  });

  it('rejects the 9999999999 "no phone given" placeholder', () => {
    expect(normalizeLegacyPhone(9999999999)).toBeNull();
    expect(normalizeLegacyPhone('9999999999')).toBeNull();
  });

  it('rejects any other all-same-digit number', () => {
    expect(normalizeLegacyPhone('8888888888')).toBeNull();
    expect(normalizeLegacyPhone('6666666666')).toBeNull();
  });

  it('rejects an all-same-digit number even behind a 91 prefix', () => {
    expect(normalizeLegacyPhone('919999999999')).toBeNull();
  });

  it('rejects any 11-digit number (0-prefixed landlines / support lines)', () => {
    expect(normalizeLegacyPhone('08069454407')).toBeNull();
    expect(normalizeLegacyPhone("'08069454407")).toBeNull();
  });

  it('rejects junk input', () => {
    expect(normalizeLegacyPhone('abc')).toBeNull();
    expect(normalizeLegacyPhone('127')).toBeNull(); // too short
    expect(normalizeLegacyPhone('12345')).toBeNull();
    expect(normalizeLegacyPhone(null)).toBeNull();
    expect(normalizeLegacyPhone(undefined)).toBeNull();
    expect(normalizeLegacyPhone('')).toBeNull();
  });

  it('rejects a 10-digit number whose first digit is 0-5', () => {
    expect(normalizeLegacyPhone('5876500001')).toBeNull();
    expect(normalizeLegacyPhone('0876500001')).toBeNull();
  });
});
