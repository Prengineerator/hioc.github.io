import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { fetchGatewayPayment, verifyCheckoutSignature } from '@/lib/payments/gateway';
import { captureGatewayPayment } from '@/lib/payments/reconcile';

export const dynamic = 'force-dynamic';

// POST /api/payments/verify — called from Checkout.js's success handler with
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }. Public: the
// signature (HMAC over order_id|payment_id with our key secret) is the access
// control — only Razorpay can produce a valid one.
//
// A valid signature proves Razorpay accepted the payment for this order, but
// we still only mark it paid once the payment is actually CAPTURED (M4).
// Auto-capture normally lands within a second; if it hasn't yet, we report
// payment_pending and let the webhook / reconcile poll finish the job.
// Idempotent with both of those paths via captureGatewayPayment.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  const gatewayOrderId = body?.razorpay_order_id;
  const gatewayPaymentId = body?.razorpay_payment_id;
  const signature = body?.razorpay_signature;
  if (
    typeof gatewayOrderId !== 'string' ||
    typeof gatewayPaymentId !== 'string' ||
    typeof signature !== 'string' ||
    !gatewayOrderId ||
    !gatewayPaymentId ||
    !signature
  ) {
    return errorResponse(
      400,
      'razorpay_order_id, razorpay_payment_id and razorpay_signature are required',
    );
  }

  if (!verifyCheckoutSignature(gatewayOrderId, gatewayPaymentId, signature)) {
    return errorResponse(400, 'Payment signature verification failed');
  }

  const attempt = await fetchGatewayPayment(gatewayPaymentId);
  if (!attempt || attempt.order_id !== gatewayOrderId || attempt.status !== 'captured') {
    return NextResponse.json({ verified: true, payment_status: 'payment_pending' });
  }

  const result = await captureGatewayPayment({
    gatewayOrderId,
    gatewayPaymentId,
    method: attempt.method,
    signatureOk: true,
    capturedAmountPaise: attempt.amount, // M5 cross-check
  });
  if (!result.ok) {
    return errorResponse(500, 'Failed to record payment');
  }

  return NextResponse.json({
    verified: true,
    payment_status: result.order?.payment_status ?? 'paid',
    order_status: result.order?.status ?? null,
  });
}
