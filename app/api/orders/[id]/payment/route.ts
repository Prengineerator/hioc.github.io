import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { settleOrderPayment } from '@/lib/orders/settlePayment';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// GET /api/orders/[id]/payment — staff/owner only. The tender breakdown for one
// order: the POS4-1 parts if it was split, else a single synthetic part for the
// whole total. REF-1's refund panel uses this to ask which tender to give back
// on, and to cap the amount per tender.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
export async function GET(_request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();

  const { data: order } = await admin
    .from('orders')
    .select('payment_method, payment_status, total_inr, subtotal_inr')
    .eq('id', id)
    .maybeSingle();
  if (!order) return notFound();

  // `reference` (the dining-app booking ID) is new in
  // 2026-10-aggregator-payments.sql; a database without it still answers.
  type TenderRow = { method: string; amount_inr: number; reference?: string | null };
  const withRef = await admin
    .from('order_payments')
    .select('method, amount_inr, tendered_inr, reference')
    .eq('order_id', id)
    .order('created_at', { ascending: true });
  let parts = withRef.data as TenderRow[] | null;
  if (withRef.error) {
    const { data } = await admin
      .from('order_payments')
      .select('method, amount_inr, tendered_inr')
      .eq('order_id', id)
      .order('created_at', { ascending: true });
    parts = data as TenderRow[] | null;
  }

  const rows = parts ?? [];
  const tenders =
    rows.length > 0
      ? rows
      : order.payment_method
        ? [
            {
              method: order.payment_method as string,
              amount_inr: (order.total_inr as number | null) ?? (order.subtotal_inr as number),
            },
          ]
        : [];

  return NextResponse.json({ tenders, payment_status: order.payment_status });
}

// PATCH /api/orders/[id]/payment — staff/owner only. Records how a walk-up paid
// (STF-041). The rules live in lib/orders/settlePayment.ts, which POST
// /api/orders also uses to settle the order it has just created. Two accepted
// shapes:
//
//   { payment_method, payment_status?, reference? }   single method for the whole bill
//                                     (payment_status: unpaid | payment_pending | paid;
//                                     a refund state is refused, refunds have their own route)
//   { parts: [{ method, amount_inr, tendered_inr?, reference? }], adjustment? }   POS4-1 split
//
// A dining-app tender (Swiggy Dineout, Zomato District) must carry the
// platform's booking / transaction ID as `reference`, and that ID must not be
// on another live order already.
//        settlement; `adjustment: { short_inr?, tip_inr?, reason }` settles for
//        LESS than the bill (a settlement discount) or MORE (a tip). The parts
//        are then what actually entered the till: total - short + tip. A short
//        above ₹50 needs a manager or the owner. A HIOC Ritual sale can't be
//        settled short at all (tips are fine).
//
// Fulfillment status is untouched — payment tracking is deliberately independent
// of the order_status lifecycle. Since BILL-1, a settle to 'paid' also delivers
// the bill.
//
// PIN-3/PIN-4: gated by getCounterActor() — classic session first, unchanged;
// an enrolled-device PIN operator only when there is no session at all. The
// operator's id is what order_payments.created_by attributes the settle to,
// same as a classic session's id would.
export async function PATCH(request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const outcome = await settleOrderPayment(actor, id, body);
  if (!outcome.ok) return errorResponse(outcome.status, outcome.error);
  return NextResponse.json(outcome.body);
}
