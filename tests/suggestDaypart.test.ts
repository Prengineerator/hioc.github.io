import { describe, expect, it } from 'vitest';
import { daypartFor } from '@/lib/suggest/daypart';

// IST = UTC+5:30, no DST, so an explicit +05:30 offset in the ISO string
// pins each instant to the exact IST wall-clock time we want to test,
// regardless of the machine's own timezone.
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

describe('daypartFor', () => {
  it('is morning from 06:00 up to 11:59:59', () => {
    expect(daypartFor(ist('2026-09-24T06:00:00'))).toBe('morning');
    expect(daypartFor(ist('2026-09-24T09:30:00'))).toBe('morning');
    expect(daypartFor(ist('2026-09-24T11:59:59'))).toBe('morning');
  });

  it('is afternoon from 12:00 up to 16:59:59', () => {
    expect(daypartFor(ist('2026-09-24T12:00:00'))).toBe('afternoon');
    expect(daypartFor(ist('2026-09-24T14:00:00'))).toBe('afternoon');
    expect(daypartFor(ist('2026-09-24T16:59:59'))).toBe('afternoon');
  });

  it('is evening from 17:00 up to 20:59:59', () => {
    expect(daypartFor(ist('2026-09-24T17:00:00'))).toBe('evening');
    expect(daypartFor(ist('2026-09-24T19:00:00'))).toBe('evening');
    expect(daypartFor(ist('2026-09-24T20:59:59'))).toBe('evening');
  });

  it('is late from 21:00 through 05:59:59, wrapping midnight', () => {
    expect(daypartFor(ist('2026-09-24T21:00:00'))).toBe('late');
    expect(daypartFor(ist('2026-09-24T23:30:00'))).toBe('late');
    expect(daypartFor(ist('2026-09-24T00:00:00'))).toBe('late');
    expect(daypartFor(ist('2026-09-24T05:59:59'))).toBe('late');
  });

  it('is timezone-independent: the same UTC instant used for an IST evening hour', () => {
    // 2026-09-24T11:30:00Z = 2026-09-24T17:00:00+05:30 (evening boundary).
    expect(daypartFor(new Date('2026-09-24T11:30:00Z'))).toBe('evening');
  });
});
