// PRN-2 — which PRINTERS a job goes to, given the owner's configuration.
//
// `placementPrintPlan()` / `settlePrintPlan()` (lib/staff/autoPrint.ts) already
// decide which TICKETS a moment owes (a KOT, a receipt, a token). This module
// is the next step, unique to the desktop shell: a KOT role can be assigned to
// more than one printer (kitchen AND bar), a role can be assigned to none (a
// loud configuration error at print time, not a silent skip — PRN-2), and each
// assignment carries its own copy count. Pure and printer-agnostic: it knows
// nothing about ESC/POS, IPC or the bridge.

import type { PrinterConfig, PrinterRole } from '@/lib/desktop/bridge';
import type { PrintType } from '@/lib/staff/autoPrint';

const MIN_COPIES = 1;
const MAX_COPIES = 5;
const DEFAULT_COPIES = 1;

function clampCopies(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_COPIES;
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, Math.trunc(n)));
}

/**
 * Every printer configured to take this role, each with its (clamped) copy
 * count. Order follows `printers` — stable, so "Kitchen then Bar" prints in
 * the order the owner listed them.
 */
export function routeJob(
  printers: PrinterConfig[],
  type: PrintType,
): { printer: PrinterConfig; copies: number }[] {
  const role: PrinterRole = type;
  return printers
    .filter((p) => p.roles.includes(role))
    .map((printer) => ({ printer, copies: clampCopies(printer.copies[role]) }));
}

/** The one printer wired to the cash drawer, or null if none is. */
export function drawerPrinter(printers: PrinterConfig[]): PrinterConfig | null {
  return printers.find((p) => p.drawer) ?? null;
}
