import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { createPaymentIntent, fetchOrderPaymentAttempts } from '@/lib/payments/gateway';
import { captureGatewayPayment } from '@/lib/payments/reconcile';
import { canTransition } from '@/lib/orders/stateMachine';
import { canPayOnline, canTransitionPayment } from '@/lib/orders/paymentStateMachine';
import { abandonGatewayPayments } from '@/lib/payments/evidence';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
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

  // `gateway_checked`: is this answer final? true when the stored status is not
  // 'payment_pending' (the database already knows), or when Razorpay was asked
  // and holds no payment for this order (nothing captured, nothing authorized
  // and on its way). false when 'payment_pending' could not be confirmed: the
  // gateway lookup failed, a captured payment could not be recorded, or an
  // authorized payment is still being captured. A caller about to start a NEW
  // sale because the earlier one "is still pending" (components/passes/
  // ritualSaleGuard.ts) must not act on a false — that is how a customer gets
  // charged twice while the gateway is unreachable.
  if (order.payment_status !== 'payment_pending') {
    return NextResponse.json({ payment_status: order.payment_status, order_status: order.status, gateway_checked: true });
  }

  const { data: payment } = await admin
    .from('payments')
    .select('gateway_order_id')
    .eq('order_id', orderId)
    .eq('gateway', 'razorpay')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // No gateway order was ever created, so nothing can have been paid on one.
  let gatewayChecked = true;
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
          gateway_checked: true,
        });
      }
    }
    gatewayChecked = attempts !== null && !captured && !attempts.some((a) => a.status === 'authorized');
  }

  return NextResponse.json({
    payment_status: order.payment_status,
    order_status: order.status,
    gateway_checked: gatewayChecked,
  });
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
    // '*' rather than a column list: order_kind (HIOC Ritual) only exists once
    // supabase/2026-10-coffee-pass.sql is applied, and naming it would fail
    // every retry before then. Absent, it reads as an ordinary menu order.
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (readError) return errorResponse(500, 'Failed to load order');
  if (!current) return notFound();

  if (current.payment_status === 'paid') {
    return errorResponse(409, 'This order is already paid.');
  }
  // A cancelled, rejected, completed or refunded order is never handed a
  // Razorpay order to pay (the money would land on nothing), and is not
  // switched anywhere either.
  if (!canPayOnline(current)) {
    return errorResponse(409, 'This order is no longer waiting on payment.');
  }

  // Issue-1: a web GUEST (no session — see POST /api/orders' isWebGuest) has
  // no pay-at-counter flow at all — a guest order carries no verified phone,
  // so there's nothing else to place it on. A failed or abandoned online
  // payment must not be routed around that rule. A table-QR order still
  // starts pay-online-first at placement (POST /api/orders), but its diner is
  // physically at the table, so switching to pay at counter after a failed
  // attempt is fine for them.
  if (action === 'switch_to_counter') {
    // HIOC Ritual (CP-D8): a Ritual bought online has no pay-at-counter path.
    // Switching would park an unpaid pass sale at the counter with nothing for
    // the kitchen to make and nobody expecting to collect it. The customer
    // retries the payment, or buys it at the counter where it is sold properly.
    if ((current as { order_kind?: string }).order_kind === 'coffee_pass') {
      return errorResponse(
        409,
        `A ${PASS_PROGRAM_NAME} bought online is paid online — please retry the payment, or buy it at the counter.`,
      );
    }
    const mustPayOnline = current.channel === 'customer_web' && !current.user_id;
    if (mustPayOnline) {
      return errorResponse(
        403,
        'Guest orders must be paid online. Please retry the payment.',
      );
    }
  }

  if (action === 'retry') {
    // H2: reuse an existing pending gateway order rather than minting a second
    // one. Two open Razorpay orders for the same HIOC order could each be paid
    // once → double-charge. A single reused order can only be paid once.
    // Only one still open (payment_pending — switch-to-counter, expiry and a
    // cancel abandon theirs) and only for what the bill is now: an open one for
    // a different amount is never handed out again.
    const amount = current.total_inr ?? 0;
    const { data: pending } = await admin
      .from('payments')
      .select('gateway_order_id, amount_inr')
      .eq('order_id', orderId)
      .eq('gateway', 'razorpay')
      .eq('status', 'payment_pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pending?.gateway_order_id && pending.amount_inr === amount) {
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

    if (pending?.gateway_order_id) {
      // The bill changed since that Razorpay order was made: abandon it so it
      // is never paid for the old amount, then mint one for the bill as it is.
      await abandonGatewayPayments(admin, orderId);
    }
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
  // The customer moves it (the event below has always said so); the payment
  // leaves the gateway with it (payment_pending → unpaid, 'switch_to_counter').
  const check = canTransition(from, 'received', 'customer');
  const payCheck = canTransitionPayment(current.payment_status, 'unpaid', 'switch_to_counter', 'customer', {
    orderStatus: from,
  });
  if (!check.ok || !payCheck.ok) {
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
    .eq('payment_status', current.payment_status)
    .select('*')
    .maybeSingle();
  if (updateError) return errorResponse(500, 'Failed to switch to pay at counter');
  if (!updated) return errorResponse(409, 'Order was updated by someone else — please refresh.');

  // Its open Razorpay order is abandoned, so retry never hands it out again; a
  // payment still in flight on it is recorded when it lands — it marks this
  // order paid if the counter hasn't collected yet, and is kept as an orphan to
  // refund if it has (lib/payments/reconcile.ts).
  await abandonGatewayPayments(admin, orderId);

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
