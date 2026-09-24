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
    }
  /** Left text and right-aligned value on one line (wraps the left side). */
  | { kind: 'row'; left: string; right: string; bold?: boolean }
  | { kind: 'divider' }
  | { kind: 'feed'; lines: number }
  | { kind: 'qr'; data: string };

export interface TicketDoc {
  type: PrintType;
  orderId: string;
  blocks: TicketBlock[];
}
