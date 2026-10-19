import { describe, expect, it } from 'vitest';
import {
  exportFileName,
  exportHref,
  isMonth,
  lastDayOfMonth,
  previousMonth,
  resolvePeriod,
  wholeMonthOf,
} from '@/lib/reports/exports/period';

describe('month helpers', () => {
  it('reads YYYY-MM', () => {
    expect(isMonth('2026-09')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-9', '26-09', '2026-09-01', '', 'sept']) expect(isMonth(bad), bad).toBe(false);
  });

  it('finds the last day, leap years included', () => {
    expect(lastDayOfMonth('2026-09')).toBe('2026-09-30');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('goes back one month, across the new year', () => {
    expect(previousMonth('2026-10-19')).toBe('2026-09');
    expect(previousMonth('2026-10-01')).toBe('2026-09');
    expect(previousMonth('2027-01-05')).toBe('2026-12');
  });

  it('knows a whole calendar month from any other range', () => {
    expect(wholeMonthOf('2026-09-01', '2026-09-30')).toBe('2026-09');
    expect(wholeMonthOf('2026-02-01', '2026-02-28')).toBe('2026-02');
    expect(wholeMonthOf('2026-09-02', '2026-09-30')).toBeNull();
    expect(wholeMonthOf('2026-09-01', '2026-09-29')).toBeNull();
    expect(wholeMonthOf('2026-09-01', '2026-10-31')).toBeNull();
  });
});

describe('resolvePeriod', () => {
  const today = '2026-10-19';

  it('turns a month into its first and last day', () => {
    expect(resolvePeriod({ month: '2026-09' }, today)).toEqual({ ok: true, from: '2026-09-01', to: '2026-09-30' });
  });

  it('runs the month in progress to today and refuses one that has not started', () => {
    expect(resolvePeriod({ month: '2026-10' }, today)).toEqual({ ok: true, from: '2026-10-01', to: '2026-10-19' });
    expect(resolvePeriod({ month: '2026-11' }, today).ok).toBe(false);
  });

  it('refuses a malformed month, and month wins over from/to', () => {
    expect(resolvePeriod({ month: '2026-13' }, today).ok).toBe(false);
    expect(resolvePeriod({ month: '2026-08', from: '2026-09-05', to: '2026-09-06' }, today)).toEqual({
      ok: true,
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('falls back to from/to (an empty month is no month), then to today', () => {
    expect(resolvePeriod({ month: '', from: '2026-09-05', to: '2026-09-06' }, today)).toEqual({ ok: true, from: '2026-09-05', to: '2026-09-06' });
    expect(resolvePeriod({}, today)).toEqual({ ok: true, from: today, to: today });
  });
});

describe('export names and links', () => {
  it('names a whole month by the month, anything else by its dates', () => {
    expect(exportFileName('orders', '2026-09-01', '2026-09-30')).toBe('hioc-orders-2026-09.csv');
    expect(exportFileName('orders', '2026-09-05', '2026-09-20')).toBe('hioc-orders-2026-09-05_to_2026-09-20.csv');
    expect(exportFileName('gstr1-b2cs', '2026-09-30', '2026-09-30')).toBe('hioc-gstr1-b2cs-2026-09-30_to_2026-09-30.csv');
  });

  it('links to the export route', () => {
    expect(exportHref('gst-summary', '2026-09-01', '2026-09-30')).toBe(
      '/api/owner/reports/export?report=gst-summary&from=2026-09-01&to=2026-09-30',
    );
  });
});
