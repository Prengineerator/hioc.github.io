import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { createGatewayRefund } from '@/lib/payments/gateway';
import { reverseForOrder } from '@/lib/loyalty/ledger';
import type { PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/refund — manager/owner only (FND-5 gate; FND-2/PAY-3).
// Issues a full or partial refund via the gateway against the order's most
// recent captured payment, writes a `refunds` row EITHER WAY (processed or
// failed — a failed gateway call is logged, never silently dropped per the
// FND-2 AC), and sets orders.payment_status to 'refunded' (fully) or
// 'partially_refunded'. Any points earned/redeemed on the order are clawed
// back (FND-4 edge case). Body: { amount_inr?: number, reason: string } —
// amount_inr omitted = full refund of whatever remains unrefunded.
export async function POST(request: Request, { params }: RouteParams) {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return errorResponse(400, 'reason is required');
  }

  const admin = createAdminSupabaseClient();

  const { data: order, error: orderError } = await admin
    .from('orders')
    .select('id, payment_status')
    .eq('id', id)
    .maybeSingle();
  if (orderError) return errorResponse(500, 'Failed to load order');
  if (!order) return notFound();

  if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded') {
    return errorResponse(409, 'This order has no captured payment to refund.');
  }

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, gateway_payment_id, amount_inr')
    .eq('order_id', id)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (paymentError) return errorResponse(500, 'Failed to load payment');
  if (!payment || !payment.gateway_payment_id) {
    return errorResponse(409, 'No captured gateway payment found for this order.');
  }

  const { data: priorRefunds, error: priorError } = await admin
    .from('refunds')
    .select('amount_inr')
    .eq('payment_id', payment.id)
    .eq('status', 'processed');
  if (priorError) return errorResponse(500, 'Failed to load prior refunds');

  const alreadyRefunded = (priorRefunds ?? []).reduce(
    (sum, r) => sum + (r.amount_inr as number),
    0,
  );
  const refundable = payment.amount_inr - alreadyRefunded;
  if (refundable <= 0) {
    return errorResponse(409, 'This payment has already been fully refunded.');
  }

  let amountInr = refundable;
  if (body?.amount_inr !== undefined) {
    if (
      typeof body.amount_inr !== 'number' ||
      !Number.isInteger(body.amount_inr) ||
      body.amount_inr <= 0
    ) {
      return errorResponse(400, 'amount_inr must be a positive integer');
    }
    amountInr = body.amount_inr;
  }
  if (amountInr > refundable) {
    // Block partial refund exceeding what's left to refund (FND-2 edge case).
    return errorResponse(400, `amount_inr exceeds the refundable balance (₹${refundable})`);
  }

  const gatewayResult = await createGatewayRefund(payment.gateway_payment_id, amountInr, {
    reason,
    hioc_order_id: id,
  });

  if (!gatewayResult) {
    await admin.from('refunds').insert({
      payment_id: payment.id,
      order_id: id,
      amount_inr: amountInr,
      reason,
      status: 'failed',
      created_by: manager.id,
    });
    return errorResponse(
      502,
      'Refund failed at the payment gateway — it has been logged; please retry.',
    );
  }

  const { data: refundRow, error: refundError } = await admin
    .from('refunds')
    .insert({
      payment_id: payment.id,
      order_id: id,
      amount_inr: amountInr,
      reason,
      status: 'processed',
      gateway_ref: gatewayResult.id,
      created_by: manager.id,
      processed_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (refundError) {
    // The gateway refund already succeeded — log so it's investigable, but
    // don't fail the request over a bookkeeping write (money already moved).
    console.error('refunds insert failed after a successful gateway refund', refundError);
  }

  const totalRefunded = alreadyRefunded + amountInr;
  const newPaymentStatus: PaymentStatus =
    totalRefunded >= payment.amount_inr ? 'refunded' : 'partially_refunded';

  const { data: updatedOrder, error: updateError } = await admin
    .from('orders')
    .update({ payment_status: newPaymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (updateError) {
    console.error('order payment_status update after refund failed', updateError);
  }

  // Claw back points ONLY on a FULL refund (H8). reverseForOrder reverses the
  // order's ENTIRE earn+redeem, so running it on a partial refund would wrongly
  // wipe all earned points (e.g. a ₹10 refund on a ₹1000 order). A partial
  // refund leaves loyalty untouched.
  if (newPaymentStatus === 'refunded') {
    await reverseForOrder(id);
  }

  return NextResponse.json({ refund: refundRow, order: updatedOrder });
}
