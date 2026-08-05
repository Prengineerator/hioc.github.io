import { describe, expect, it } from 'vitest';
import {
  AUTO_PRINT_DEFAULTS,
  placementPrintPlan,
  printUrl,
  readAutoPrintSettings,
  settlePrintPlan,
} from '@/lib/staff/autoPrint';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';

// POS4-3 — the rules that decide what the counter prints on its own. Pure, no
// mocks: a wrong answer here is either a kitchen with no ticket or a printer
// burning a roll a day.

describe('readAutoPrintSettings', () => {
  it('reads the stored switches', () => {
    expect(readAutoPrintSettings({ auto_print_kot: false, auto_print_bill: true })).toEqual({
      kot: false,
      bill: true,
    });
  });

  it('falls back to the migration defaults when the columns are absent', () => {
    // A deploy that lands before supabase/2026-08-auto-print.sql is applied must
    // behave exactly like a migrated one, not stop printing.
    expect(readAutoPrintSettings({})).toEqual(AUTO_PRINT_DEFAULTS);
    expect(readAutoPrintSettings(null)).toEqual(AUTO_PRINT_DEFAULTS);
    expect(readAutoPrintSettings(undefined)).toEqual(AUTO_PRINT_DEFAULTS);
  });

  it('defaults the KOT on and the bill off', () => {
    expect(AUTO_PRINT_DEFAULTS).toEqual({ kot: true, bill: false });
  });

  it('agrees with the settings fallback row', () => {
    // The two defaults are declared in two places (the fallback settings row and
    // this module); they must not drift.
    expect(readAutoPrintSettings(FALLBACK_STORE_SETTINGS)).toEqual(AUTO_PRINT_DEFAULTS);
  });
});

describe('placementPrintPlan', () => {
  it('prints the KOT when the switch is on', () => {
    expect(placementPrintPlan({ kot: true, bill: false }, { settled: false })).toEqual(['kot']);
  });

  it('prints nothing when both switches are off — behaviour is exactly as before', () => {
    expect(placementPrintPlan({ kot: false, bill: false }, { settled: true })).toEqual([]);
  });

  it('adds the receipt only when the order was actually settled', () => {
    expect(placementPrintPlan({ kot: true, bill: true }, { settled: true })).toEqual([
      'kot',
      'receipt',
    ]);
    // "Collect later" has taken no money — a receipt would be paper for a bill
    // nobody paid.
    expect(placementPrintPlan({ kot: true, bill: true }, { settled: false })).toEqual(['kot']);
  });
});

describe('settlePrintPlan', () => {
  it('prints the receipt when the bill switch is on', () => {
    expect(settlePrintPlan({ kot: true, bill: true })).toEqual(['receipt']);
  });

  it('never reprints the KOT — the kitchen got it at placement', () => {
    expect(settlePrintPlan({ kot: true, bill: false })).toEqual([]);
  });
});

describe('printUrl', () => {
  it('points at the existing staff-gated print page', () => {
    expect(printUrl('11111111-2222-3333-4444-555555555555', 'kot')).toBe(
      '/staff-print/11111111-2222-3333-4444-555555555555/kot',
    );
    expect(printUrl('abc', 'receipt')).toBe('/staff-print/abc/receipt');
  });
});
