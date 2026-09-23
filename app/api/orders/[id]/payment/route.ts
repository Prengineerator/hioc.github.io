import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isPaymentMethod, isUuid, PAYMENT_METHODS } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { sendBillNotification } from '@/lib/notifications/engine';
import { dominantMethod, validateParts, type PaymentPart } from '@/lib/orders/payments';
import type { Order, PaymentMethod, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'unpaid',
  'payment_pending',
  'paid',
  'refunded',
  'partially_refunded',
];

// GET /api/orders/[id]/payment — staff/owner only. The tender breakdown for one
// order: the POS4-1 parts if it was split, else a single synthetic part for the
// whole total. REF-1's refund panel uses this to ask which tender to give back
// on, and to cap the amount per tender.
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();

  const { data: order } = await admin
    .from('orders')
    .select('payment_method, payment_status, total_inr, subtotal_inr')
    .eq('id', id)
    .maybeSingle();
  if (!order) return notFound();

  const { data: parts } = await admin
    .from('order_payments')
    .select('method, amount_inr, tendered_inr')
    .eq('order_id', id)
    .order('created_at', { ascending: true });

  const rows = (parts ?? []) as { method: string; amount_inr: number }[];
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
// (STF-041). Two accepted shapes:
//
//   { payment_method, payment_status? }   single method for the whole bill
//   { parts: [{ method, amount_inr, tendered_inr? }] }   POS4-1 split settlement
//
// Fulfillment status is untouched — payment tracking is deliberately independent
// of the order_status lifecycle. Since BILL-1, a settle to 'paid' also delivers
// the bill.
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const isSplit = body.parts !== undefined;
  if (!isSplit && !isPaymentMethod(body.payment_method)) {
    return errorResponse(400, `payment_method is required and must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  let paymentStatus: PaymentStatus = 'paid';
  if (body.payment_status !== undefined) {
    if (
      typeof body.payment_status !== 'string' ||
      !(PAYMENT_STATUSES as readonly string[]).includes(body.payment_status)
    ) {
      return errorResponse(400, `payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}`);
    }
    paymentStatus = body.payment_status as PaymentStatus;
  }

  const admin = createAdminSupabaseClient();

  // Don't let a manual "mark payment" clobber a gateway-verified online payment
  // (M6) — those are reconciled against Razorpay and may only change via the
  // refund flow. Guard against overwriting an online paid/refunded record.
  // `total_inr` comes along because a split must be validated against the
  // SERVER's total, never a total the client tells us.
  const { data: existing } = await admin
    .from('orders')
    .select('payment_method, payment_status, total_inr, subtotal_inr')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return notFound();
  if (
    existing.payment_method === 'online' &&
    ['paid', 'refunded', 'partially_refunded'].includes(existing.payment_status as string)
  ) {
    return errorResponse(
      409,
      'This order was paid online — its payment is managed by the gateway and can only change via a refund.',
    );
  }

  // POS4-1: validate the split against the authoritative total before touching
  // anything. The parts must sum exactly — a gap would surface later as an
  // unexplained cash-drawer variance nobody can reconstruct.
  let parts: PaymentPart[] | null = null;
  let changeInr = 0;
  if (isSplit) {
    const orderTotal = (existing.total_inr as number | null) ?? (existing.subtotal_inr as number);
    const validated = validateParts(body.parts, orderTotal);
    if (!validated.ok) return errorResponse(400, validated.error);
    parts = validated.parts;
    changeInr = validated.changeInr;
  }

  const methodToStore = parts ? dominantMethod(parts) : (body.payment_method as PaymentMethod);

  const { data, error } = await admin
    .from('orders')
    .update({ payment_method: methodToStore, payment_status: paymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to record payment');
  }
  if (!data) {
    return notFound();
  }

  // POS4-1: persist the parts. Written AFTER the order update so a failed
  // settle leaves no orphan parts. Replaces any prior parts for this order so a
  // re-settle (staff correcting how it was paid) doesn't double-count cash.
  if (parts) {
    await admin.from('order_payments').delete().eq('order_id', id);
    const { error: partsError } = await admin.from('order_payments').insert(
      parts.map((p) => ({
        order_id: id,
        method: p.method,
        amount_inr: p.amount_inr,
        tendered_inr: p.tendered_inr ?? null,
        created_by: user.id,
      })),
    );
    if (partsError) {
      // The order reads as paid but the drawer breakdown is missing — that's a
      // cash-reconciliation problem, so say so loudly rather than swallow it.
      console.error(
        `order_payments insert FAILED for order ${id} — the cash day will fall back to the ` +
          `whole total on '${methodToStore}'. Is supabase/2026-08-split-payments.sql applied?`,
        partsError,
      );
    }
  }

  // BILL-1: deliver the bill the moment the money is taken. The POS "Collect now"
  // step settles through THIS route and never transitions status, so before this
  // a counter order got NO bill at all until someone separately marked it
  // completed in the queue — which on a busy counter never happens. The bill for
  // a settled order belongs here, not only on the completed transition.
  //
  // Exactly-once is the engine's job: its per-(order, event, channel) idempotency
  // makes the later completed-transition send a no-op, so the customer can't get
  // two. Only a genuinely settled order bills — 'payment_pending' (an online
  // order awaiting the gateway) must not.
  //
  // Reloaded with its lines so the bill's item count ({{4}}) is accurate; `data`
  // above is a plain select('*') and carries no items. Best-effort and fully
  // wrapped: a slow or failing provider must never fail settlement — the printed
  // bill remains the guaranteed copy.
  if (paymentStatus === 'paid') {
    try {
      const { data: full } = await admin
        .from('orders')
        .select('*, order_items(*, order_item_addons(*))')
        .eq('id', id)
        .single();
      await sendBillNotification(full ? toOrderResponse(full as OrderRowWithItems) : (data as Order));
    } catch (billError) {
      console.error('settle bill notification failed', billError);
    }
  }

  // `change_due_inr` lets the POS show "give ₹120 back" without recomputing it.
  return NextResponse.json({ order: data as Order, change_due_inr: changeInr });
}
