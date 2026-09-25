import { describe, expect, it } from 'vitest';
import { fiscalYearOf, parsePetpoojaDate, parsePetpoojaDateTime } from '@/lib/petpooja/dates';

describe('parsePetpoojaDateTime', () => {
  it('parses a Petpooja "Created" string as IST wall clock', () => {
    expect(parsePetpoojaDateTime('27 Jun 2025 00:11:03')).toBe('2025-06-27T00:11:03+05:30');
  });

  it('pads a single-digit day', () => {
    expect(parsePetpoojaDateTime('1 Apr 2026 00:00:00')).toBe('2026-04-01T00:00:00+05:30');
  });

  it('throws on an unparseable string', () => {
    expect(() => parsePetpoojaDateTime('not a date')).toThrow();
    expect(() => parsePetpoojaDateTime('25 Sep 2026')).toThrow(); // missing time
  });
});

describe('parsePetpoojaDate', () => {
  it('parses a date-only string to YYYY-MM-DD', () => {
    expect(parsePetpoojaDate('25 Sep 2026')).toBe('2026-09-25');
    expect(parsePetpoojaDate('9 Jan 2010')).toBe('2010-01-09');
  });

  it('returns null for blank input', () => {
    expect(parsePetpoojaDate('')).toBeNull();
    expect(parsePetpoojaDate('   ')).toBeNull();
  });

  it('returns null for unparseable input rather than throwing', () => {
    expect(parsePetpoojaDate('not a date')).toBeNull();
  });
});

describe('fiscalYearOf', () => {
  it('puts 31 Mar 23:59 IST in the fiscal year ending that March', () => {
    expect(fiscalYearOf('2026-03-31T23:59:00+05:30')).toBe('2025-26');
  });

  it('rolls to the new fiscal year at 1 Apr 00:00 IST', () => {
    expect(fiscalYearOf('2026-04-01T00:00:00+05:30')).toBe('2026-27');
  });

  it('agrees on the same boundary expressed in UTC', () => {
    // 31 Mar 23:59 IST == 18:29 UTC same day; 1 Apr 00:00 IST == 18:30 UTC previous day.
    expect(fiscalYearOf('2026-03-31T18:29:00Z')).toBe('2025-26');
    expect(fiscalYearOf('2026-03-31T18:30:00Z')).toBe('2026-27');
  });

  it('handles a mid-year date', () => {
    expect(fiscalYearOf('2025-09-25T12:00:00+05:30')).toBe('2025-26');
  });
});
