import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { fetchGatewayPayment, verifyCheckoutSignature } from '@/lib/payments/gateway';
import { captureShopPayment } from '@/lib/shop/payments';

export const dynamic = 'force-dynamic';

// POST /api/shop/verify — the shop's Checkout.js success handler, the twin of
// POST /api/payments/verify for café orders. Body: { razorpay_order_id,
// razorpay_payment_id, razorpay_signature }. Public: the signature (HMAC with
// our key secret) is the access control.
//
// Marks the order paid only once Razorpay reports the payment CAPTURED; until
// then it answers payment_pending and the webhook or the order page's poll
// finishes the job (all three are idempotent through captureShopPayment).
// Not gated on the shop flag: a payment already taken must always be recorded.
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
    return errorResponse(400, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  }

  if (!verifyCheckoutSignature(gatewayOrderId, gatewayPaymentId, signature)) {
    return errorResponse(400, 'Payment signature verification failed');
  }

  const attempt = await fetchGatewayPayment(gatewayPaymentId);
  if (!attempt || attempt.order_id !== gatewayOrderId || attempt.status !== 'captured') {
    return NextResponse.json({ verified: true, status: 'payment_pending' });
  }

  const result = await captureShopPayment({
    gatewayOrderId,
    gatewayPaymentId,
    method: attempt.method,
    capturedAmountPaise: attempt.amount,
  });
  if (!result.handled) return errorResponse(404, 'That payment is not for a shop order');

  return NextResponse.json({ verified: true, status: result.order.status, order_id: result.order.id });
}
