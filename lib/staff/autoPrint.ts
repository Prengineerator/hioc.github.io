// POS4-3 — the pure half of "the ticket prints without a second click".
//
// Opening the window has to happen inside the staffer's click (see the callers);
// what lives here is the decision — which prints a given moment owes, and where
// each one points. The POS and the order detail both read these rules so the
// two settle paths can't drift into printing different things.

import type { StoreSettings } from '@/lib/types';

export type PrintType = 'kot' | 'receipt' | 'token';

export interface AutoPrintSettings {
  kot: boolean;
  bill: boolean;
}

/**
 * Mirrors the NOT NULL DEFAULTs in supabase/2026-08-auto-print.sql. Duplicated
 * here on purpose: a deploy that runs ahead of the migration reads a row with no
 * such columns, and it must behave exactly like a freshly migrated one rather
 * than silently stop printing.
 */
export const AUTO_PRINT_DEFAULTS: AutoPrintSettings = { kot: true, bill: false };

export function readAutoPrintSettings(
  settings: Partial<StoreSettings> | null | undefined,
): AutoPrintSettings {
  return {
    kot: settings?.auto_print_kot ?? AUTO_PRINT_DEFAULTS.kot,
    bill: settings?.auto_print_bill ?? AUTO_PRINT_DEFAULTS.bill,
  };
}

/** The existing staff-gated 80mm print page (KOT-1 / KOT-2). */
export function printUrl(orderId: string, type: PrintType): string {
  return `/staff-print/${orderId}/${type}`;
}

/**
 * What to print when an order is PLACED from the POS. The bill only prints for
 * an order that was actually settled at the counter — a "collect later" tab has
 * no final bill yet, and printing one would hand the customer a receipt for
 * money nobody has taken.
 */
export function placementPrintPlan(
  settings: AutoPrintSettings,
  opts: { settled: boolean },
): PrintType[] {
  const plan: PrintType[] = [];
  if (settings.kot) plan.push('kot');
  if (settings.bill && opts.settled) plan.push('receipt');
  return plan;
}

/**
 * What to print when an already-placed order is SETTLED from the order detail.
 * No KOT: the kitchen got its ticket when the order was placed, and a second one
 * at payment time reads as a second order on the rail.
 */
export function settlePrintPlan(settings: AutoPrintSettings): PrintType[] {
  return settings.bill ? ['receipt'] : [];
}
