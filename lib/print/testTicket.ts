// PRN-3 — the fixed TicketDocs behind the Printers screen's "Test print" and
// "Test cut" buttons (components/staff/PrinterSettings.tsx). Pulled out of
// that component so the pure layout — in particular the alignment ruler,
// which must be exactly the paper's column count wide — is unit-testable
// without a DOM/React test harness, which this repo doesn't otherwise use.

import type { TicketDoc } from '@/lib/print/ticketDoc';
import type { CutMode } from '@/lib/print/escpos';

export const CUT_MODES: CutMode[] = ['standard', 'partial', 'full', 'legacy'];

export const CUT_MODE_LABELS: Record<CutMode, string> = {
  standard: 'Standard',
  partial: 'Partial',
  full: 'Full',
  legacy: 'Legacy',
};

/** One-line hint per style — printers vary in which of these they actually
 * implement (PRN-3 field report), so the copy nudges toward trying another. */
export const CUT_MODE_HINTS: Record<CutMode, string> = {
  standard: 'Works on most thermal printers — feeds to the cutter itself.',
  partial: 'Older ESC/POS command set; leaves a small connecting tab.',
  full: 'Older ESC/POS command set; cuts all the way through.',
  legacy: 'Pre-ESC/POS-2.0 printers — try this if nothing else cuts.',
};

/** Paper columns at Font A, matching lib/print/escpos.ts. */
export function colsFor(paperWidthMm: 58 | 80): number {
  return paperWidthMm === 80 ? 48 : 32;
}

/** A `1234567890…` ruler cut to exactly `cols` wide, for checking alignment. */
export function rulerLine(cols: number): string {
  return '1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols);
}

/** `|` at both edges of the paper with nothing but spaces between, `cols` wide. */
export function edgeLine(cols: number): string {
  return cols <= 2 ? '|'.repeat(cols) : `|${' '.repeat(cols - 2)}|`;
}

/** The tiny fixed ticket a "Test print" sends — not a real order. Includes an
 * alignment ruler at the paper's actual column count so a mismatched paper
 * width shows up immediately as a wrapped or truncated ruler. */
export function testTicketDoc(printerName: string, paperWidthMm: 58 | 80): TicketDoc {
  const cols = colsFor(paperWidthMm);
  return {
    type: 'receipt',
    orderId: 'test',
    blocks: [
      { kind: 'text', text: 'HIOC test print', align: 'center', bold: true, size: 'large' },
      { kind: 'text', text: printerName, align: 'center' },
      { kind: 'text', text: new Date().toLocaleString('en-IN'), align: 'center' },
      { kind: 'divider' },
      { kind: 'text', text: rulerLine(cols) },
      { kind: 'text', text: edgeLine(cols) },
      { kind: 'text', text: "If the ruler wraps or is cut off, check Paper width." },
    ],
  };
}

/** The tiny fixed ticket a "Test cut" sends — same idea as testTicketDoc but
 * shorter, since it exists only to prove the currently-saved cut style. */
export function cutTestTicketDoc(cutMode: CutMode): TicketDoc {
  return {
    type: 'receipt',
    orderId: 'test',
    blocks: [
      { kind: 'text', text: 'HIOC POS — cut test', align: 'center', bold: true },
      { kind: 'text', text: CUT_MODE_LABELS[cutMode], align: 'center' },
      { kind: 'text', text: new Date().toLocaleString('en-IN'), align: 'center' },
    ],
  };
}
