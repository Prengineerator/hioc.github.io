import { describe, expect, it } from 'vitest';
import {
  AUTO_PRINT_DEFAULTS,
  acceptPrintPlan,
  placementPrintPlan,
  printUrl,
  printsKot,
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

describe('acceptPrintPlan', () => {
  it('prints the KOT when a website order is accepted, like a counter order at placement', () => {
    expect(acceptPrintPlan({ kot: true, bill: false }, { paid: false })).toEqual(['kot']);
    expect(acceptPrintPlan({ kot: true, bill: false }, { paid: false, orderKind: 'menu' })).toEqual(['kot']);
  });

  it('follows the same KOT switch as the POS', () => {
    expect(acceptPrintPlan({ kot: false, bill: true }, { paid: false })).toEqual([]);
  });

  it('prints the receipt, after the KOT, for an order already paid online', () => {
    expect(acceptPrintPlan({ kot: true, bill: true }, { paid: true })).toEqual(['kot', 'receipt']);
    expect(acceptPrintPlan({ kot: false, bill: true }, { paid: true })).toEqual(['receipt']);
  });

  it('follows the same bill switch as the POS for a prepaid order', () => {
    expect(acceptPrintPlan({ kot: true, bill: false }, { paid: true })).toEqual(['kot']);
  });

  it('leaves a pay-at-counter order its receipt for when it is settled', () => {
    expect(acceptPrintPlan({ kot: true, bill: true }, { paid: false })).toEqual(['kot']);
  });

  it('never sends a pass sale to the kitchen', () => {
    expect(acceptPrintPlan({ kot: true, bill: true }, { paid: false, orderKind: 'coffee_pass' })).toEqual([]);
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

// HIOC Ritual: the SALE of a pass is a payment, not food. Whatever the KOT switch
// says, no ticket goes to the kitchen for it (and it has no pickup token either):
// its receipt is the one thing it prints.
describe('a HIOC Ritual sale never prints a KOT', () => {
  it('printsKot is false only for a coffee_pass order', () => {
    expect(printsKot('coffee_pass')).toBe(false);
    expect(printsKot('menu')).toBe(true);
    // Rows read before the migration have no order_kind: a menu order.
    expect(printsKot(undefined)).toBe(true);
    expect(printsKot(null)).toBe(true);
  });

  it.each([
    ['kot on, bill on, settled', { kot: true, bill: true }, true, ['receipt']],
    ['kot on, bill off, settled', { kot: true, bill: false }, true, []],
    ['kot on, bill on, unpaid', { kot: true, bill: true }, false, []],
    ['kot off, bill on, settled', { kot: false, bill: true }, true, ['receipt']],
  ])('placementPrintPlan for a pass sale: %s', (_label, settings, settled, expected) => {
    expect(placementPrintPlan(settings, { settled, orderKind: 'coffee_pass' })).toEqual(expected);
  });

  it('settlePrintPlan prints the receipt only, for a pass sale as for any order', () => {
    expect(settlePrintPlan({ kot: true, bill: true }, { orderKind: 'coffee_pass' })).toEqual(['receipt']);
    expect(settlePrintPlan({ kot: true, bill: false }, { orderKind: 'coffee_pass' })).toEqual([]);
  });

  it('leaves a menu order exactly as it was', () => {
    expect(placementPrintPlan({ kot: true, bill: true }, { settled: true, orderKind: 'menu' })).toEqual(['kot', 'receipt']);
    expect(placementPrintPlan({ kot: true, bill: true }, { settled: true })).toEqual(['kot', 'receipt']);
    expect(settlePrintPlan({ kot: true, bill: true }, { orderKind: 'menu' })).toEqual(['receipt']);
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
