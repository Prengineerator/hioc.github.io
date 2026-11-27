// The counter's tickets, built on the counter.
//
// Every placement print used to fetch its ticket: the desktop shell's raw path
// asked GET /api/print/ticket for the TicketDoc, and the browser path loaded
// the /staff-print page into a hidden frame. Both are a server call per ticket,
// for data the create answer had a moment earlier. POST /api/orders now hands
// that data back (include_print_order), and the job carries it, so the first
// attempt builds the ticket here with the same pure code the server runs.
//
// A retry, and any print that didn't come from a placement (a reprint from an
// order, a web order accepted at the board), still asks the server: a reprint
// must reflect the order as it is now, not as it was when it was placed.

import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import { onlyKotItems, parseKotItemsParam } from '@/lib/print/kotAddition';
import { buildTicketDoc } from '@/lib/print/ticketModel';
import type { TicketDoc } from '@/lib/print/ticketDoc';
import { printsKot, type PrintType } from '@/lib/staff/autoPrint';

/** The fields of a print job this needs (lib/pos/printQueue PrintJob). */
export interface LocalPrintSource {
  type: PrintType;
  itemIds?: string[];
  printOrder?: StaffPrintOrder;
  attempts: number;
}

/** The ticket data to print this attempt from, or null to ask the server. */
export function localPrintOrder(job: Pick<LocalPrintSource, 'printOrder' | 'attempts'>): StaffPrintOrder | null {
  return job.printOrder && job.attempts <= 1 ? job.printOrder : null;
}

/**
 * The order exactly as the server's print surfaces would narrow it: a KOT of
 * only the added lines when `itemIds` is set (parsed the way the `?items=`
 * query is), and no kitchen ticket or pickup token at all for a HIOC Ritual
 * sale, which is a payment, not food. Throws for that case, so the queue
 * shows a failed job rather than a phantom order on the kitchen's rail.
 */
export function ticketOrderFor(
  order: StaffPrintOrder,
  type: PrintType,
  itemIds?: readonly string[] | null,
): StaffPrintOrder {
  if ((type === 'kot' || type === 'token') && !printsKot(order.order_kind)) {
    throw new Error('A HIOC Ritual sale has no kitchen ticket or pickup token.');
  }
  return type === 'kot' ? onlyKotItems(order, parseKotItemsParam(itemIds ? itemIds.join(',') : null)) : order;
}

/** The TicketDoc GET /api/print/ticket would answer for this job. */
export function localTicketDoc(order: StaffPrintOrder, type: PrintType, itemIds?: readonly string[] | null): TicketDoc {
  return buildTicketDoc(ticketOrderFor(order, type, itemIds), type);
}
