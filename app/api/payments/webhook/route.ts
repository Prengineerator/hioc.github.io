import { NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/payments/gateway';
import { captureGatewayPayment, markGatewayPaymentFailed } from '@/lib/payments/reconcile';

export const dynamic = 'force-dynamic';

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        method?: string;
        amount?: number; // paise (M5 cross-check)
        error_description?: string;
      };
    };
    order?: { entity?: { id?: string } };
  };
}

// POST /api/payments/webhook — Razorpay server webhook (FND-1). Verifies the
// HMAC signature against the RAW request body (must be read as text BEFORE
// any JSON parsing — the signature covers the exact bytes Razorpay sent),
// then handles payment.captured/order.paid (mark paid + unblock the order
// into the staff queue) and payment.failed (record the failure; the order
// stays 'placed'/payment_pending, never surfaced to staff). Idempotent by
// gateway_order_id — safe to receive the same event more than once (Razorpay
// retries on any non-2xx response).
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = payload.event;
  const paymentEntity = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;

  try {
    if (event === 'payment.captured' || event === 'order.paid') {
      const gatewayOrderId = paymentEntity?.order_id ?? orderEntity?.id;
      const gatewayPaymentId = paymentEntity?.id;
      if (gatewayOrderId && gatewayPaymentId) {
        await captureGatewayPayment({
          gatewayOrderId,
          gatewayPaymentId,
          method: paymentEntity?.method,
          signatureOk: true,
          capturedAmountPaise: paymentEntity?.amount, // M5 cross-check
        });
      }
    } else if (event === 'payment.failed') {
      const gatewayOrderId = paymentEntity?.order_id;
      if (gatewayOrderId) {
        await markGatewayPaymentFailed(
          gatewayOrderId,
          paymentEntity?.error_description ?? 'Payment failed',
        );
      }
    }
    // Other events (refund.processed, etc.) are ignored — refunds are
    // initiated (and recorded) by our own manager-triggered refund route,
    // not by this inbound webhook.
  } catch (err) {
    console.error('payments/webhook handling failed', err);
    // Still 200 below — a transient failure here is recovered by the next
    // reconcile poll (GET /api/payments/[orderId]/status), and returning a
    // non-2xx would just cause Razorpay to hammer retries for no benefit.
  }

  return NextResponse.json({ received: true });
}
