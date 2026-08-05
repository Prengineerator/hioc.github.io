import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isPaymentMethod, isUuid, PAYMENT_METHODS } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { sendBillNotification } from '@/lib/notifications/engine';
import type { Order, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'unpaid',
  'payment_pending',
  'paid',
  'refunded',
  'partially_refunded',
];

// PATCH /api/orders/[id]/payment — staff/owner only. Records how a walk-up paid
// (STF-041): sets payment_method and payment_status (defaults to 'paid' when a
// method is provided). Fulfillment status is untouched — payment tracking is
// deliberately independent of the order_status lifecycle.
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
  if (!body || !isPaymentMethod(body.payment_method)) {
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
  const { data: existing } = await admin
    .from('orders')
    .select('payment_method, payment_status')
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

  const { data, error } = await admin
    .from('orders')
    .update({ payment_method: body.payment_method, payment_status: paymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to record payment');
  }
  if (!data) {
    return notFound();
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

  return NextResponse.json({ order: data as Order });
}
