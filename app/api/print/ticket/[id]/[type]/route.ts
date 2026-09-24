import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { unauthorized, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getStaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import { buildTicketDoc } from '@/lib/print/ticketModel';
import type { PrintType } from '@/lib/staff/autoPrint';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string; type: string } };

const PRINT_TYPES: readonly PrintType[] = ['kot', 'receipt', 'token'];

function isPrintType(value: string): value is PrintType {
  return (PRINT_TYPES as readonly string[]).includes(value);
}

// GET /api/print/ticket/[id]/[type] — PRN-3. Staff-gated JSON source for the
// desktop shell's native ESC/POS driver (PrinterService): returns the exact
// same TicketDoc the HTML /staff-print page renders from (buildTicketDoc), so
// the printed paper and the on-screen ticket can never disagree. Never
// cached — a reprint must reflect the order's current state (voids, payment,
// points earned), not a stale snapshot.
export async function GET(_request: Request, { params }: RouteParams) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();

  const { id, type } = params;
  if (!isUuid(id) || !isPrintType(type)) return notFound();

  const order = await getStaffPrintOrder(id);
  if (!order) return notFound();

  return NextResponse.json(
    { doc: buildTicketDoc(order, type) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
