// One 80mm ticket on its page: the frame the /staff-print page draws, and the
// same frame the POS draws into its own print iframe when it prints from the
// order it already has (components/staff/LocalPrintFrame.tsx). One copy, so the
// paper can't differ by which path printed it. Presentational, no hooks: it
// renders as a Server Component on the page and inside a client portal alike.

import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { PrintType } from '@/lib/staff/autoPrint';
import { KotTicket, ReceiptTicket, TokenSlip } from '@/components/print/StaffTickets';

/*
 * PRT-2 — the page geometry, declared here rather than left to the printer
 * driver.
 * `margin: 0` is the load-bearing half: the margin box is where Chrome draws
 * the URL, the date and the page number, and on a receipt roll that means every
 * ticket carries "staff.hioc.in/staff-print/..." across the top and wastes an
 * inch of paper. There is no print dialog to untick those boxes in once kiosk
 * printing is on, so the page has to refuse the margin box outright.
 * `size: 80mm auto` keeps the roll continuous instead of being broken into
 * letter-sized pages when the driver's default paper is A4 — the state a
 * freshly installed printer is usually in.
 * Scoped to the ticket by living with it: @page is document-global, and the
 * customer receipt and the A6 QR cards have their own geometry.
 */
export const TICKET_PAGE_CSS = '@page { size: 80mm auto; margin: 0; }';

/** The 80mm column, plus anything that sits above the ticket (the print page's toolbar). */
export function TicketPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-[80mm] max-w-full px-3 py-6 text-black print:w-full print:px-0 print:py-0">
      <style>{TICKET_PAGE_CSS}</style>
      {children}
    </div>
  );
}

/** The ticket itself, for an order already narrowed to what it prints (onlyKotItems). */
export function TicketSheet({ order, type }: { order: StaffPrintOrder; type: PrintType }) {
  return (
    <div className="rounded-md border border-line bg-white p-4 shadow-sm print:border-0 print:p-0 print:shadow-none">
      {type === 'kot' ? (
        <KotTicket order={order} />
      ) : type === 'receipt' ? (
        <ReceiptTicket order={order} />
      ) : (
        <TokenSlip order={order} />
      )}
    </div>
  );
}
