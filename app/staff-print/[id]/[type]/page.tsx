import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { isUuid } from '@/lib/api/constants';
import { getStaffOrOwner } from '@/lib/api/auth';
import { getStaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import { KotTicket, ReceiptTicket, TokenSlip } from '@/components/print/StaffTickets';
import { AutoPrint } from '@/components/print/AutoPrint';
import { PrintOnLoad } from './PrintOnLoad';

// Staff-gated 80mm print surface for KOT-1 (kitchen ticket) and KOT-2 (receipt
// / token slip). Decision D3: the thermal printer is USB-connected, so v1 prints
// through the browser's system print dialog — no driver code.
//
// Chrome-hiding: this route lives OUTSIDE /staff/** on purpose, so it inherits
// the ROOT layout (app/layout.tsx) whose SiteHeader/SiteFooter are already
// `print:hidden` — the exact approach the customer receipt (app/order/[id]/
// receipt) uses — instead of the /staff layout's StaffHeader (which has no
// print-hidden and is owned by another engineer). Access is gated in-page via
// getStaffOrOwner() → redirect to /staff/login, since middleware only guards
// /staff/** and /owner/**. The order is regenerated from the stored row, so it's
// always current and needs no client fetch.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Print' };

const TYPES = new Set(['kot', 'receipt', 'token']);
const LABELS: Record<string, string> = {
  kot: 'Print KOT',
  receipt: 'Print receipt',
  token: 'Print token',
};

export default async function StaffPrintPage({
  params,
  searchParams,
}: {
  params: { id: string; type: string };
  searchParams?: { auto?: string };
}) {
  const { id, type } = params;
  if (!isUuid(id) || !TYPES.has(type)) {
    notFound();
  }

  // In-page staff gate (this route is outside the middleware-guarded /staff/**).
  // It stands unchanged for the PRT-1 iframe: the frame is same-origin, so this
  // runs with the staffer's own cookies, and an unauthenticated embed renders the
  // login redirect inside a 0×0 frame — printing nothing, leaking nothing.
  const account = await getStaffOrOwner();
  if (!account) {
    redirect('/staff/login');
  }

  // PRT-1 — `?auto=1` means the POS mounted this page in a hidden iframe: print
  // on load and report back, no toolbar. Without it this is still the tab a
  // staffer opened by hand, unchanged.
  const auto = searchParams?.auto === '1';

  const order = await getStaffPrintOrder(id);
  if (!order) {
    notFound();
  }

  return (
    <div className="mx-auto w-[80mm] max-w-full px-3 py-6 text-black print:w-full print:px-0 print:py-0">
      {/* On-screen toolbar — auto-opens the print dialog; print:hidden. */}
      {auto ? <PrintOnLoad orderId={id} type={type} /> : <AutoPrint label={LABELS[type]} />}

      <div className="rounded-md border border-[#e5e5e5] bg-white p-4 shadow-sm print:border-0 print:p-0 print:shadow-none">
        {type === 'kot' ? (
          <KotTicket order={order} />
        ) : type === 'receipt' ? (
          <ReceiptTicket order={order} />
        ) : (
          <TokenSlip order={order} />
        )}
      </div>
    </div>
  );
}
