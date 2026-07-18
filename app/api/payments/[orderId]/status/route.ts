import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { createPaymentIntent, fetchOrderPaymentAttempts } from '@/lib/payments/gateway';
import { captureGatewayPayment } from '@/lib/payments/reconcile';
import { canTransition } from '@/lib/orders/stateMachine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { orderId: string } };

// GET /api/payments/[orderId]/status — public (the opaque order id is the
// access control, exactly like GET /api/orders/[id]). Reconciles a pending
// online payment against the gateway when the webhook hasn't landed yet
// (FND-1 "webhook delayed" edge case): polls Razorpay's payment attempts for
// the order and captures the first captured/authorized one it finds. The
// customer status page calls this on a short poll while pending — each call
// covers the "bounded reconciliation window" requirement.
export async function GET(_request: Request, { params }: RouteParams) {
  const { orderId } = params;
  if (!isUuid(orderId)) return notFound();

  const admin = createAdminSupabaseClient();
  const { data: order, error } = await admin
    .from('orders')
    .select('id, status, payment_status')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return errorResponse(500, 'Failed to load order');
  if (!order) return notFound();

  if (order.payment_status !== 'payment_pending') {
    return NextResponse.json({ payment_status: order.payment_status, order_status: order.status });
  }

  const { data: payment } = await admin
    .from('payments')
    .select('gateway_order_id')
    .eq('order_id', orderId)
    .eq('gateway', 'razorpay')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (payment?.gateway_order_id) {
    const attempts = await fetchOrderPaymentAttempts(payment.gateway_order_id);
    // Only a CAPTURED payment means money settled (M4). An 'authorized' one is
    // not yet captured — treating it as paid could queue an order before the
    // charge completes.
    const captured = attempts?.find((a) => a.status === 'captured');
    if (captured) {
      const result = await captureGatewayPayment({
        gatewayOrderId: payment.gateway_order_id,
        gatewayPaymentId: captured.id,
        method: captured.method,
        signatureOk: false, // reconciled via API poll, not a signed webhook
        capturedAmountPaise: captured.amount, // M5 cross-check
      });
      if (result.order) {
        return NextResponse.json({
          payment_status: result.order.payment_status,
          order_status: result.order.status,
        });
      }
    }
  }

  return NextResponse.json({ payment_status: order.payment_status, order_status: order.status });
}

// POST /api/payments/[orderId]/status — customer payment actions (PAY-2).
// Body: { action: 'retry' | 'switch_to_counter' }.
//  - 'retry': mints a fresh gateway payment intent for another attempt.
//  - 'switch_to_counter': abandons online payment and moves the order into
//    the normal pay-at-counter flow ('placed' → 'received', unpaid).
// Public (opaque order id is the access control).
export async function POST(request: Request, { params }: RouteParams) {
  const { orderId } = params;
  if (!isUuid(orderId)) return notFound();

  const body = await parseJsonBody(request);
  const action = body?.action;
  if (action !== 'retry' && action !== 'switch_to_counter') {
    return errorResponse(400, 'action must be "retry" or "switch_to_counter"');
  }

  const admin = createAdminSupabaseClient();
  const { data: current, error: readError } = await admin
    .from('orders')
    .select('id, status, version, payment_status, total_inr')
    .eq('id', orderId)
    .maybeSingle();
  if (readError) return errorResponse(500, 'Failed to load order');
  if (!current) return notFound();

  if (current.payment_status === 'paid') {
    return errorResponse(409, 'This order is already paid.');
  }

  if (action === 'retry') {
    // H2: reuse an existing pending gateway order rather than minting a second
    // one. Two open Razorpay orders for the same HIOC order could each be paid
    // once → double-charge. A single reused order can only be paid once.
    const { data: pending } = await admin
      .from('payments')
      .select('gateway_order_id, amount_inr')
      .eq('order_id', orderId)
      .eq('gateway', 'razorpay')
      .eq('status', 'payment_pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pending?.gateway_order_id) {
      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || '';
      return NextResponse.json({
        payment: {
          gateway: 'razorpay',
          gatewayOrderId: pending.gateway_order_id,
          amountInr: pending.amount_inr,
          keyId,
        },
      });
    }

    const amount = current.total_inr ?? 0;
    const intent = await createPaymentIntent(orderId, amount);
    if (!intent) {
      return errorResponse(
        502,
        'The payment gateway is currently unavailable — please pay at the counter instead.',
      );
    }
    return NextResponse.json({ payment: intent });
  }

  // action === 'switch_to_counter'
  const from = current.status as Order['status'];
  if (from !== 'placed') {
    return errorResponse(409, 'This order is no longer waiting on payment.');
  }
  const check = canTransition(from, 'received', 'system');
  if (!check.ok) {
    return errorResponse(409, 'This order can no longer switch to pay at the counter.');
  }

  const { data: updated, error: updateError } = await admin
    .from('orders')
    .update({
      status: 'received',
      payment_status: 'unpaid',
      payment_method: null,
      version: (current.version as number) + 1,
    })
    .eq('id', orderId)
    .eq('version', current.version)
    .select('*')
    .maybeSingle();
  if (updateError) return errorResponse(500, 'Failed to switch to pay at counter');
  if (!updated) return errorResponse(409, 'Order was updated by someone else — please refresh.');

  await admin.from('order_status_events').insert({
    order_id: orderId,
    from_status: from,
    to_status: 'received',
    actor_id: null,
    actor_role: 'customer',
    reason: 'Switched to pay at counter',
  });
  await broadcastOrderEvent(orderId, 'received');

  return NextResponse.json({ order: updated as Order });
}
