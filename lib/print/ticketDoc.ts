// PRN-3 — a printer-neutral description of one ticket.
//
// `lib/print/ticketModel.ts` builds it from an order; `lib/print/escpos.ts`
// turns it into ESC/POS bytes for a given paper width. Keeping the layout as
// data (not JSX, not bytes) is what lets the kitchen and counter printers get
// the same ticket content the HTML print page shows.
//
// Served by GET /api/print/ticket/[id]/[type] → `{ doc: TicketDoc }`
// (staff-gated; 401 unauthenticated, 404 unknown order/type).

import type { PrintType } from '@/lib/staff/autoPrint';

export type TicketAlign = 'left' | 'center' | 'right';

/**
 * One column of a `columns` block. `weight` is a relative share of the
 * available width (after gaps and `minWidth` floors are reserved) — not an
 * absolute character count, so the block is printer-width-agnostic; see
 * `layoutColumns` in lib/print/escpos.ts for how it becomes real columns at
 * 48 vs 32 cols.
 */
export interface TicketColumn {
  text: string;
  /** Relative share of the row's width. Columns with a larger weight get
   * proportionally more of whatever width is left after every column's
   * `minWidth` is reserved. */
  weight: number;
  align?: TicketAlign;
  /** Floor on this column's character width — reserved before `weight` is
   * applied to the remainder. Defaults to 1. */
  minWidth?: number;
  /** May be dropped entirely on narrow paper (58mm / 32 cols) if the row's
   * columns don't all fit at their `minWidth` — e.g. the item table's Price
   * column. Never dropped at 48 cols (80mm). */
  optional?: boolean;
}

export type TicketBlock =
  | {
      kind: 'text';
      text: string;
      align?: TicketAlign;
      bold?: boolean;
      /** normal = 1x, large = double height, xlarge = double width + height. */
      size?: 'normal' | 'large' | 'xlarge';
      /** Voided KOT lines. ESC/POS has no strike: rendered as "[VOID]" + text. */
      strike?: boolean;
      /**
       * Left indent (character columns) applied to EVERY wrapped line, not
       * just the first — a hanging indent for addon/note lines meant to sit
       * under a table column (e.g. the receipt item table's Item column):
       * the wrap width shrinks by this much so a long line still fits, and
       * each wrapped continuation line gets the same indent rather than
       * falling back to column 0. Only meaningful for `align: 'left'`
       * (the default) — ESC/POS's own centered/right alignment already
       * positions the whole line, so `indent` is ignored there.
       */
      indent?: number;
    }
  /** Left text and right-aligned value on one line (wraps the left side). */
  | {
      kind: 'row';
      left: string;
      right: string;
      bold?: boolean;
      /** normal = 1x, large = double height (no width change — the row still
       * fills the same character columns). Used for the Grand Total line. */
      size?: 'normal' | 'large';
    }
  /**
   * A tabular row laid out into N columns by the renderer, e.g. the item
   * table's header ("No. Item Qty. Price Amount") and its item lines. Each
   * column carries a relative `weight` (its share of the row's width once
   * fixed gaps/minWidths are accounted for) rather than an absolute
   * character count, so the SAME block renders correctly at both 48 cols
   * (80mm) and 32 cols (58mm) — see `layoutColumns` in lib/print/escpos.ts,
   * which also drops an `optional` column (the Price column, at 58mm) when
   * the remaining columns' `minWidth`s don't fit.
   */
  | { kind: 'columns'; columns: TicketColumn[]; bold?: boolean }
  | { kind: 'divider' }
  | { kind: 'feed'; lines: number }
  | { kind: 'qr'; data: string }
  /**
   * A 1-bit raster image (logo, or the rasterized brand header), centered and
   * printed with `GS v 0`. Rows are MSB-first, `bytesPerRow = ceil(widthDots
   * / 8)`, 1 = black — see `lib/print/escpos.ts` and
   * `lib/print/brandHeaderRaster.ts`, which produces one of these.
   */
  | { kind: 'raster'; widthDots: number; heightDots: number; data: Uint8Array }
  /**
   * Placeholder for the logo + "हाईओक" / "HIOC." header on receipts and
   * token slips (lib/print/ticketModel.ts). Resolved to a `raster` block by
   * `resolveBrandHeader` (lib/desktop/printExecutor.ts) before printing; if it
   * reaches `renderEscPos` unresolved (rasterization unavailable or failed —
   * `getBrandHeaderRaster` returns null on any error), it falls back to
   * centered double-size "HIOC." text so a bad logo/font load can never break
   * a print job. NOT emitted on the KOT.
   */
  | { kind: 'brandHeader' };

export interface TicketDoc {
  type: PrintType;
  orderId: string;
  blocks: TicketBlock[];
}

/** The resolved form of a `brandHeader` block once rasterized. */
export type RasterBlock = Extract<TicketBlock, { kind: 'raster' }>;
