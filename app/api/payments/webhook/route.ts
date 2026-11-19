import { NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/payments/gateway';
import { captureGatewayPayment, markGatewayPaymentFailed } from '@/lib/payments/reconcile';
import { captureShopPayment, captureShopPaymentLink, closeUnpaidShopLinkOrder } from '@/lib/shop/payments';

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
    // payment_link.* events (owner-entered shop orders). Shapes follow Razorpay's
    // docs; not verified against a live account.
    payment_link?: { entity?: { id?: string; amount_paid?: number; short_url?: string; expire_by?: number; notes?: Record<string, unknown> | unknown[] } };
  };
}

function shopOrderIdFromNotes(notes: unknown): string | null {
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return null;
  const id = (notes as Record<string, unknown>).shop_order_id;
  return typeof id === 'string' ? id : null;
}

// POST /api/payments/webhook — Razorpay server webhook (FND-1). Verifies the
// HMAC signature against the RAW request body (must be read as text BEFORE
// any JSON parsing — the signature covers the exact bytes Razorpay sent),
// then handles payment.captured/order.paid (mark paid + unblock the order
// into the staff queue) and payment.failed (record the failure; the order
// stays 'placed'/payment_pending, never surfaced to staff). Idempotent by
// gateway_order_id — safe to receive the same event more than once (Razorpay
// retries on any non-2xx response). payment_link.paid / .expired / .cancelled belong to
// owner-entered shop orders (lib/shop/payments.ts): paid is captured by the shop's one
// capture step (amount checked against the order), expired / cancelled close an unpaid one.
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
        // The Instant Coffee shop shares this webhook URL. A Razorpay order that
        // belongs to a shop order is recorded there (lib/shop/payments.ts) and
        // never reaches the café's payments/orders; anything else is a café
        // order, exactly as before.
        const shop = await captureShopPayment({
          gatewayOrderId,
          gatewayPaymentId,
          method: paymentEntity?.method,
          capturedAmountPaise: paymentEntity?.amount,
        });
        if (shop.handled) return NextResponse.json({ received: true });
        await captureGatewayPayment({
          gatewayOrderId,
          gatewayPaymentId,
          method: paymentEntity?.method,
          signatureOk: true,
          capturedAmountPaise: paymentEntity?.amount, // M5 cross-check
        });
      }
    } else if (event === 'payment_link.paid') {
      // An owner-entered shop order paid through its Razorpay payment link. Handled
      // only by the shop's capture step (same idempotent path as a website payment);
      // it never reaches the café's payments.
      const link = payload.payload?.payment_link?.entity;
      const gatewayPaymentId = paymentEntity?.id;
      if (link?.id && !gatewayPaymentId) {
        console.error(`payments/webhook: payment_link.paid for link ${link.id} carried no payment id; not captured`);
      }
      if (link?.id && gatewayPaymentId) {
        await captureShopPaymentLink({
          paymentLinkId: link.id,
          shopOrderId: shopOrderIdFromNotes(link.notes),
          gatewayPaymentId,
          method: paymentEntity?.method,
          // The payment's own amount; the link's amount_paid when the payment is not in the payload.
          capturedAmountPaise: paymentEntity?.amount ?? link.amount_paid,
          shortUrl: typeof link.short_url === 'string' ? link.short_url : null,
          expireBy: typeof link.expire_by === 'number' ? link.expire_by : null,
        });
      }
    } else if (event === 'payment_link.expired' || event === 'payment_link.cancelled') {
      const link = payload.payload?.payment_link?.entity;
      if (link?.id) {
        await closeUnpaidShopLinkOrder(
          { paymentLinkId: link.id, shopOrderId: shopOrderIdFromNotes(link.notes) },
          event === 'payment_link.expired' ? 'expired' : 'cancelled',
        );
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
